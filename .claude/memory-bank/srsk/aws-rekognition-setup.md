# AWS Rekognition — настройка (07.02.2026)

## Аккаунт
- AWS Account: srsk (8188-1114-2778)
- Region: ap-south-1 (Mumbai)

## IAM
- User: `srsk-rekognition` (programmatic access only)
- Policy: `SrskRekognitionOnly` — минимальные права:
  - rekognition:CreateCollection, DeleteCollection, IndexFaces, DeleteFaces, SearchFacesByImage, ListCollections, ListFaces

## Supabase Edge Function Secrets
- `AWS_ACCESS_KEY_ID` = AKIA35JHSQJ5FE5JST62
- `AWS_SECRET_ACCESS_KEY` = сохранён
- `AWS_REGION` = ap-south-1
- Project: llttmftapmwebidgevmg

## Проверка
- Edge Function test-rekognition: ListCollections → 200, работает
- AWS Signature V4 реализован вручную (без SDK, Deno-compatible)
- Код подписи можно переиспользовать в index-faces и search-face

## Supabase CLI
- Установлен: v2.75.0
- Access token сохранён в .env.local (в gitignore)
