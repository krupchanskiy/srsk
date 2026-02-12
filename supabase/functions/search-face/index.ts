// supabase/functions/search-face/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  RekognitionClient,
  SearchFacesByImageCommand,
} from "npm:@aws-sdk/client-rekognition@3.624.0";

type SearchFaceRequest = {
  retreat_id: string;
  vaishnava_id: string;

  // Optional: if provided, we use it as "selfie" / override.
  // If not provided, we try to read vaishnavas.photo_url.
  photo_url?: string;

  threshold?: number; // default 80
  max_faces?: number; // default 100
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AWS_ACCESS_KEY_ID = Deno.env.get("AWS_ACCESS_KEY_ID")!;
const AWS_SECRET_ACCESS_KEY = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
const AWS_REGION = Deno.env.get("AWS_REGION") || "ap-south-1";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}

async function downloadImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

async function sendFoundPhotosNotification(supabase: any, vaishnavId: string, photosCount: number) {
  try {
    // Получить telegram_chat_id пользователя
    const { data: vaishnava } = await supabase
      .from("vaishnavas")
      .select("telegram_chat_id, spiritual_name, first_name, last_name")
      .eq("id", vaishnavId)
      .single();

    if (!vaishnava || !vaishnava.telegram_chat_id) {
      console.log(`Vaishnava ${vaishnavId} doesn't have Telegram connected`);
      return;
    }

    const name = vaishnava.spiritual_name || `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim();
    const plural = photosCount === 1 ? 'фотографии' : (photosCount >= 2 && photosCount <= 4 ? 'фотографиях' : 'фотографиях');

    const message = `📸 *Нашли вас на фото!*\n\n${name}, мы нашли вас на ${photosCount} ${plural}!\n\nПосмотреть: https://in.rupaseva.com/guest-portal/photos.html`;

    // Вызов send-notification Edge Function
    await supabase.functions.invoke('send-notification', {
      body: {
        type: 'single',
        vaishnavId: vaishnavId,
        message: message,
        parseMode: 'Markdown'
      }
    });

    console.log(`✅ Notification sent to vaishnava ${vaishnavId}: ${photosCount} photos found`);
  } catch (err) {
    console.error('Error sending found photos notification:', err);
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  // Verify authorization header exists
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization header" }, 401);
  }

  let body: SearchFaceRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const retreat_id = body?.retreat_id;
  const vaishnava_id = body?.vaishnava_id;
  const threshold = body?.threshold ?? 80;
  const maxFaces = body?.max_faces ?? 100;

  if (!retreat_id || !vaishnava_id) {
    return json({ error: "retreat_id and vaishnava_id are required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const rek = new RekognitionClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  const collectionId = `retreat_${retreat_id}`;

  try {
    // 1) Resolve image URL: request photo_url (selfie) OR profile url from vaishnavas
    let imageUrl: string | null = body.photo_url ?? null;

    if (!imageUrl) {
      const { data: v, error: vErr } = await supabase
        .from("vaishnavas")
        .select("photo_url")
        .eq("id", vaishnava_id)
        .maybeSingle();

      if (vErr) {
        return json({ error: "DB read vaishnavas failed", details: vErr.message }, 500);
      }

      imageUrl = (v as any)?.photo_url ?? null;

      if (!imageUrl) {
        // This is the "need selfie" fallback
        return json(
          {
            ok: false,
            code: "NO_PROFILE_PHOTO",
            retreat_id,
            vaishnava_id,
            message: "No profile photo found in vaishnavas.photo_url. Provide photo_url (selfie) to search.",
          },
          400,
        );
      }
    }

    // 2) Download image
    const bytes = await downloadImageBytes(imageUrl);

    // Check size limit
    const sizeMB = bytes.byteLength / (1024 * 1024);
    if (sizeMB > 10) {
      return json({ error: `Image too large: ${sizeMB.toFixed(2)}MB (max 10MB)` }, 400);
    }

    // 3) Search faces in retreat collection
    const resp = await rek.send(
      new SearchFacesByImageCommand({
        CollectionId: collectionId,
        FaceMatchThreshold: threshold,
        MaxFaces: maxFaces,
        Image: { Bytes: bytes },
      }),
    );

    const matches = resp.FaceMatches ?? [];
    const faceIds = matches
      .map((m) => m.Face?.FaceId)
      .filter(Boolean) as string[];

    if (faceIds.length === 0) {
      return json({
        ok: true,
        retreat_id,
        vaishnava_id,
        used_photo_url: imageUrl,
        matched_photo_ids: [],
        total: 0,
        threshold,
        message: "No face matches found in collection",
      });
    }

    // 4) Map Rekognition FaceId -> photo_id via photo_faces
    const { data: faceRows, error: faceErr } = await supabase
      .from("photo_faces")
      .select("photo_id, rekognition_face_id")
      .in("rekognition_face_id", faceIds);

    if (faceErr) {
      return json({ error: "DB select photo_faces failed", details: faceErr.message }, 500);
    }

    const faceIdToPhotoId = new Map<string, string>();
    for (const r of faceRows ?? []) {
      faceIdToPhotoId.set((r as any).rekognition_face_id, (r as any).photo_id);
    }

    // Best confidence per photo (take max similarity among faces in same photo)
    const bestByPhoto = new Map<string, number>();
    for (const m of matches) {
      const fid = m.Face?.FaceId;
      const sim = m.Similarity ?? null;
      if (!fid || sim == null) continue;

      const photoId = faceIdToPhotoId.get(fid);
      if (!photoId) continue;

      const prev = bestByPhoto.get(photoId);
      if (prev == null || sim > prev) bestByPhoto.set(photoId, sim);
    }

    const matchedPhotoIds = Array.from(bestByPhoto.keys());

    // 5) Upsert into face_tags
    // IMPORTANT: you should have UNIQUE(photo_id, vaishnava_id) for clean upsert.
    const rows = matchedPhotoIds.map((photo_id) => ({
      photo_id,
      vaishnava_id,
      confidence: bestByPhoto.get(photo_id) ?? null,
    }));

    if (rows.length > 0) {
      const { error: upErr } = await supabase
        .from("face_tags")
        .upsert(rows, { onConflict: "photo_id,vaishnava_id" });

      if (upErr) {
        return json({ error: "Upsert face_tags failed", details: upErr.message }, 500);
      }

      // Отправить Telegram уведомление пользователю о найденных фото
      if (matchedPhotoIds.length > 0) {
        await sendFoundPhotosNotification(supabase, vaishnava_id, matchedPhotoIds.length);
      }
    }

    return json({
      ok: true,
      retreat_id,
      vaishnava_id,
      used_photo_url: imageUrl,
      matched_photo_ids: matchedPhotoIds,
      total: matchedPhotoIds.length,
      threshold,
    });
  } catch (e) {
    return json({ error: "search-face failed", details: String((e as any)?.message ?? e) }, 500);
  }
});
