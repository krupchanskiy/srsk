// supabase/functions/index-faces/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  RekognitionClient,
  CreateCollectionCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
} from "npm:@aws-sdk/client-rekognition@3.624.0";


type IndexFacesRequest = {
  retreat_id: string;
  limit?: number; // optional, default 20
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AWS_ACCESS_KEY_ID = Deno.env.get("AWS_ACCESS_KEY_ID")!;
const AWS_SECRET_ACCESS_KEY = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
const AWS_REGION = Deno.env.get("AWS_REGION") || "ap-south-1";

const BUCKET_RETREAT_PHOTOS = "retreat-photos";

// If your bucket is public, this works.
// If bucket is private, switch to signed URL logic (see comment below).
function buildPublicStorageUrl(storagePath: string) {
  // IMPORTANT: storagePath already includes "{retreat_id}/file.jpg"
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_RETREAT_PHOTOS}/${storagePath}`;
}

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

async function ensureCollection(client: RekognitionClient, collectionId: string) {
  // 1) Try describe - if exists, we're done
  try {
    await client.send(new DescribeCollectionCommand({ CollectionId: collectionId }));
    return;
  } catch (e) {
    // if not found – we'll try to create below
  }

  // 2) Try create - if already exists, ignore
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: collectionId }));
  } catch (e: any) {
    const name = e?.name || "";
    const msg = String(e?.message || e);

    if (name === "ResourceAlreadyExistsException" || msg.includes("already exists")) {
      return;
    }
    throw e;
  }
}


async function downloadImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
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

  // Verify authorization header exists (but we don't validate it, just check presence)
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization header" }, 401);
  }

  let body: IndexFacesRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const retreat_id = body?.retreat_id;
  const limit = Math.min(Math.max(body?.limit ?? 20, 1), 50);

  if (!retreat_id) return json({ error: "retreat_id is required" }, 400);

  // Supabase client (service role: needed to update rows + insert)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // AWS Rekognition client
  const rek = new RekognitionClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });

  const collectionId = `retreat_${retreat_id}`;

  console.log(`Processing retreat ${retreat_id}, collection: ${collectionId}`);

  try {
    console.log("Ensuring collection exists...");
    await ensureCollection(rek, collectionId);
    console.log("Collection ready");
  } catch (e) {
    console.error("Failed to ensure collection:", e);
    return json({ error: "Failed to ensure Rekognition collection", details: String(e) }, 500);
  }

  // 1) Fetch photos to index
  // We take pending and failed (so you can rerun after fixing)
  console.log(`Fetching photos for retreat ${retreat_id}...`);
  const { data: candidatePhotos, error: selErr } = await supabase
    .from("retreat_photos")
    .select("id, storage_path, index_status")
    .eq("retreat_id", retreat_id)
    .in("index_status", ["pending", "failed"])
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (selErr) {
    console.error("DB select error:", selErr);
    return json({ error: "DB select failed", details: selErr.message }, 500);
  }

  if (!candidatePhotos || candidatePhotos.length === 0) {
    console.log("No photos to index");
    return json({ ok: true, retreat_id, indexed: 0, skipped: 0, message: "No photos to index" });
  }

  console.log(`Found ${candidatePhotos.length} candidate photos to index`);

  // 2) Atomically mark as processing ONLY if still pending/failed
  // This prevents race conditions from multiple concurrent calls
  const photoIds = candidatePhotos.map((p) => p.id);
  const { data: lockedPhotos, error: updErr } = await supabase
    .from("retreat_photos")
    .update({ index_status: "processing", index_error: null, updated_at: new Date().toISOString() })
    .in("id", photoIds)
    .in("index_status", ["pending", "failed"]) // Only update if still pending/failed
    .select("id, storage_path");

  if (updErr) return json({ error: "Failed to mark processing", details: updErr.message }, 500);

  if (!lockedPhotos || lockedPhotos.length === 0) {
    console.log("No photos locked (already being processed by another call)");
    return json({ ok: true, retreat_id, indexed: 0, skipped: candidatePhotos.length, message: "Already processing" });
  }

  const photos = lockedPhotos; // Use locked photos for processing
  console.log(`Locked ${photos.length} photos for processing`);

  // 3) Process each photo
  const results: Array<{
    photo_id: string;
    status: "indexed" | "failed";
    faces_indexed?: number;
    error?: string;
  }> = [];

  for (const p of photos) {
    const photo_id = p.id as string;
    const storage_path = p.storage_path as string;

    try {
      // If your bucket is PRIVATE, replace this with signed URL:
      // const { data: signed, error } = await supabase.storage.from(BUCKET_RETREAT_PHOTOS).createSignedUrl(storage_path, 60);
      // const url = signed?.signedUrl;
      const url = buildPublicStorageUrl(storage_path);

      const imageBytes = await downloadImageBytes(url);

      // Check size limit (AWS Rekognition max 15 MB)
      const sizeMB = imageBytes.byteLength / (1024 * 1024);
      if (sizeMB > 15) {
        throw new Error(`Image too large: ${sizeMB.toFixed(2)}MB (max 15MB)`);
      }

      const cmd = new IndexFacesCommand({
        CollectionId: collectionId,
        Image: { Bytes: imageBytes },
        DetectionAttributes: ["DEFAULT"],
        // Important: use ExternalImageId to trace back to photo_id
        ExternalImageId: photo_id,
        MaxFaces: 15,
        QualityFilter: "AUTO",
      });

      const resp = await rek.send(cmd);
      const faceRecords = resp.FaceRecords ?? [];

      // Delete old face records for this photo before inserting new ones
      // (prevents duplicate key constraint violations when reindexing)
      const { error: delErr } = await supabase
        .from("photo_faces")
        .delete()
        .eq("photo_id", photo_id);

      if (delErr) throw new Error(`Delete old photo_faces failed: ${delErr.message}`);

      // Insert mapping into photo_faces
      // NOTE: adjust columns if your table schema differs
      if (faceRecords.length > 0) {
        const rows = faceRecords
          .map((fr) => {
            const faceId = fr.Face?.FaceId;
            const conf = fr.Face?.Confidence ?? null;
            const bb = fr.Face?.BoundingBox;
            if (!faceId || !bb) return null;

            return {
              // id: gen_random_uuid() by default in DB
              photo_id,
              rekognition_face_id: faceId,
              bbox_left: bb.Left ?? null,
              bbox_top: bb.Top ?? null,
              bbox_width: bb.Width ?? null,
              bbox_height: bb.Height ?? null,
              confidence: conf,
            };
          })
          .filter(Boolean) as any[];

        if (rows.length > 0) {
          const { error: insErr } = await supabase.from("photo_faces").insert(rows);
          if (insErr) throw new Error(`Insert photo_faces failed: ${insErr.message}`);
        }
      }

      // Mark indexed with faces_count
      const { error: doneErr } = await supabase
        .from("retreat_photos")
        .update({
          index_status: "indexed",
          index_error: null,
          faces_count: faceRecords.length
        })
        .eq("id", photo_id);

      if (doneErr) throw new Error(`Update retreat_photos indexed failed: ${doneErr.message}`);

      results.push({ photo_id, status: "indexed", faces_indexed: faceRecords.length });
    } catch (e) {
      const msg = String((e as any)?.message ?? e);

      await supabase
        .from("retreat_photos")
        .update({ index_status: "failed", index_error: msg })
        .eq("id", photo_id);

      results.push({ photo_id, status: "failed", error: msg });
    }
  }

  const indexed = results.filter((r) => r.status === "indexed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  // Проверить: завершена ли индексация всех фото ретрита?
  // Если да — отправить Telegram уведомление участникам
  await checkAndNotifyIfIndexingComplete(supabase, retreat_id);

  return json({
    ok: true,
    retreat_id,
    collection_id: collectionId,
    processed: results.length,
    indexed,
    failed,
    results,
  });
});

// Проверка завершения индексации и отправка уведомления
async function checkAndNotifyIfIndexingComplete(supabase: any, retreatId: string) {
  try {
    // Получить статистику индексации для ретрита
    const { data: photos, error } = await supabase
      .from('retreat_photos')
      .select('index_status')
      .eq('retreat_id', retreatId);

    if (error || !photos || photos.length === 0) {
      return; // Нет фото или ошибка
    }

    const total = photos.length;
    const indexed = photos.filter((p: any) => p.index_status === 'indexed').length;
    const failed = photos.filter((p: any) => p.index_status === 'failed').length;
    const pending = photos.filter((p: any) => p.index_status === 'pending').length;
    const processing = photos.filter((p: any) => p.index_status === 'processing').length;

    // Если индексация завершена (все фото indexed или failed, нет pending/processing)
    if (indexed + failed === total && pending === 0 && processing === 0 && indexed > 0) {
      console.log(`✅ Индексация ретрита ${retreatId} завершена: ${indexed} indexed, ${failed} failed`);

      // Получить название ретрита
      const { data: retreat } = await supabase
        .from('retreats')
        .select('name_ru, name_en, name_hi')
        .eq('id', retreatId)
        .single();

      if (!retreat) {
        console.warn('Retreat not found for notification');
        return;
      }

      const retreatName = retreat.name_ru || retreat.name_en || retreat.name_hi || 'Ретрит';

      // Определяем URL (production vs dev)
      const baseUrl = SUPABASE_URL.includes('vzuiwpeovnzfokekdetq')
        ? 'https://dev.rupaseva.com' // Dev environment (Vercel)
        : 'https://in.rupaseva.com'; // Production

      const photoUrl = `${baseUrl}/guest-portal/photos.html`;

      const message = `📸 *Новые фото с ретрита!*\n\n${retreatName}\n\nЗагружено ${indexed} ${pluralizePhotos(indexed)}.\n\n[Посмотреть фотографии](${photoUrl})`;

      console.log('📤 Sending Telegram notification for retreat:', retreatId);

      // Вызвать Edge Function send-notification (service role, без проверки прав)
      const notificationResp = await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          type: 'broadcast',
          retreatId: retreatId,
          message: message,
          parseMode: 'Markdown'
        })
      });

      if (!notificationResp.ok) {
        const errorText = await notificationResp.text();
        console.error('❌ Failed to send notification:', notificationResp.status, errorText);
      } else {
        const result = await notificationResp.json();
        console.log('✅ Telegram notifications sent:', result);
      }
    } else {
      console.log(`⏳ Индексация ретрита ${retreatId} не завершена: ${indexed}/${total} indexed, ${pending} pending, ${processing} processing`);
    }
  } catch (err) {
    console.error('Error checking indexing completion:', err);
  }
}

// Плюрализация для русского языка
function pluralizePhotos(count: number): string {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return 'фотографий';
  }

  if (lastDigit === 1) {
    return 'фотография';
  } else if (lastDigit >= 2 && lastDigit <= 4) {
    return 'фотографии';
  } else {
    return 'фотографий';
  }
}
