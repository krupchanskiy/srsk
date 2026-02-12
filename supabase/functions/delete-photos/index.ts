// DELETE-PHOTOS Edge Function
// Каскадное удаление фотографий: Storage + БД + AWS Rekognition

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// AWS SDK для Rekognition
import { RekognitionClient, DeleteFacesCommand } from 'npm:@aws-sdk/client-rekognition@3.624.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DeleteRequest {
  photo_ids: string[]; // Массив ID фотографий
  retreat_id: string;
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Проверка авторизации
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { photo_ids, retreat_id }: DeleteRequest = await req.json();

    if (!photo_ids || !Array.isArray(photo_ids) || photo_ids.length === 0) {
      throw new Error('photo_ids обязателен и должен быть непустым массивом');
    }

    if (!retreat_id) {
      throw new Error('retreat_id обязателен');
    }

    // Supabase клиент (Service Role для обхода RLS)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 2. Получить user из JWT через Service Role (проверка токена)
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error('Auth error:', userError);
      return new Response(
        JSON.stringify({ error: 'Invalid authorization token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Проверить право upload_photos через функцию has_permission
    const { data: hasPermission, error: permError } = await supabase.rpc('has_permission', {
      perm_code: 'upload_photos',
      user_uuid: user.id,
    });

    if (permError) {
      console.error('Ошибка проверки прав:', permError);
      return new Response(
        JSON.stringify({ error: 'Permission check failed' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!hasPermission) {
      return new Response(
        JSON.stringify({ error: 'No upload_photos permission' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // AWS Rekognition клиент
    const rekognitionClient = new RekognitionClient({
      region: Deno.env.get('AWS_REGION') || 'ap-south-1',
      credentials: {
        accessKeyId: Deno.env.get('AWS_ACCESS_KEY_ID')!,
        secretAccessKey: Deno.env.get('AWS_SECRET_ACCESS_KEY')!,
      },
    });

    const collectionId = `retreat-${retreat_id}`;

    console.log(`Удаление ${photo_ids.length} фотографий`);

    // 1. Получить storage_path, thumb_path и face_id для удаляемых фото
    const { data: photos, error: photosError } = await supabase
      .from('retreat_photos')
      .select('id, storage_path, thumb_path')
      .in('id', photo_ids);

    if (photosError) throw photosError;

    if (!photos || photos.length === 0) {
      return new Response(
        JSON.stringify({ message: 'Фото не найдены', deleted: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Получить rekognition_face_id из photo_faces
    const { data: faces, error: facesError } = await supabase
      .from('photo_faces')
      .select('rekognition_face_id')
      .in('photo_id', photo_ids);

    if (facesError) {
      console.error('Ошибка загрузки лиц:', facesError);
    }

    const faceIds = faces?.map((f) => f.rekognition_face_id) || [];

    // 3. Удалить лица из AWS Rekognition Collection
    if (faceIds.length > 0) {
      console.log(`Удаление ${faceIds.length} лиц из Rekognition`);

      try {
        // Rekognition позволяет удалять до 4096 лиц за раз
        const batchSize = 4096;
        for (let i = 0; i < faceIds.length; i += batchSize) {
          const batch = faceIds.slice(i, i + batchSize);

          const deleteCommand = new DeleteFacesCommand({
            CollectionId: collectionId,
            FaceIds: batch,
          });

          await rekognitionClient.send(deleteCommand);
        }
      } catch (rekogError) {
        console.error('Ошибка удаления из Rekognition:', rekogError);
        // Продолжаем выполнение, даже если Rekognition упал
      }
    }

    // 4. Удалить из Storage (оригиналы + превью)
    const storagePaths: string[] = [];
    photos.forEach((p) => {
      storagePaths.push(p.storage_path);
      if (p.thumb_path) {
        storagePaths.push(p.thumb_path);
      }
    });

    console.log(`Удаление ${storagePaths.length} файлов из Storage (оригиналы + превью)`);

    const { error: storageError } = await supabase.storage
      .from('retreat-photos')
      .remove(storagePaths);

    if (storageError) {
      console.error('Ошибка удаления из Storage:', storageError);
      throw new Error(`Не удалось удалить файлы из Storage: ${storageError.message}`);
    }

    // 5. Удалить из photo_faces (каскадное удаление должно сработать автоматически через FK, но на всякий случай)
    const { error: deleteFacesError } = await supabase
      .from('photo_faces')
      .delete()
      .in('photo_id', photo_ids);

    if (deleteFacesError) {
      console.error('Ошибка удаления из photo_faces:', deleteFacesError);
    }

    // 6. Удалить из retreat_photos
    const { error: deletePhotosError } = await supabase
      .from('retreat_photos')
      .delete()
      .in('id', photo_ids);

    if (deletePhotosError) throw deletePhotosError;

    return new Response(
      JSON.stringify({
        message: 'Фотографии успешно удалены',
        deleted: photo_ids.length,
        faces_deleted: faceIds.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Ошибка функции:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
