# Vero Messenger — бесплатный Render deployment

## Что изменено

- SQLite убран из рабочей серверной части. Основная база теперь PostgreSQL.
- Добавлены таблицы для пользователей, друзей, сообщений, реакций, закреплений, аватарок и файлов.
- В `messages` добавлены `duration_seconds`, `media_kind` и `file_size`.
- Фото, видео, голосовые и аватарки больше не сохраняются на файловой системе Render.
- Медиа загружаются в Cloudinary и в PostgreSQL сохраняется URL.
- Длительность аудио/видео определяется при загрузке; если сервис не получил её от Cloudinary, браузер определяет её по metadata и отправляет на сервер.
- Видео-сообщения отображаются кругом, с кнопкой воспроизведения и длительностью.
- Исправлена проблема старой версии, когда обработчики `loadedmetadata` создавались на DOM-элементе, который затем превращался в `outerHTML`.
- Иконки основных кнопок заменены на единый SVG-стиль с синим акцентом.
- Старый GitHub backup workflow удалён: GitHub не должен использоваться как рабочая база данных.
- Добавлен `migrate-sqlite-to-postgres.js` для переноса старой SQLite-базы.

## Бесплатная схема

- Render Free — сервер Node.js.
- Neon Free — PostgreSQL.
- Cloudinary Free — фото/видео/голосовые/аватарки.

Render Free имеет эфемерную файловую систему, поэтому SQLite и загруженные файлы нельзя хранить там постоянно. Render прямо указывает, что локальные файлы теряются при перезапуске/redeploy/spin-down. Поэтому база вынесена в Neon, а медиа — в Cloudinary.

## Переменные окружения Render

Скопируйте значения из `.env.example` в Render → Environment.

Обязательные:

- `DATABASE_URL` — connection string из Neon.
- `JWT_SECRET` — длинная случайная строка.
- `ADMIN_EMAIL`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `MAX_FILE_SIZE` — обычно `100`.

## Neon

1. Создайте аккаунт Neon.
2. Создайте Free PostgreSQL project.
3. Скопируйте pooled connection string.
4. Вставьте его в Render как `DATABASE_URL`.
5. При первом запуске `server.js` сам создаст таблицы и индексы.

## Cloudinary

1. Создайте бесплатный аккаунт Cloudinary.
2. В Dashboard найдите Cloud Name, API Key и API Secret.
3. Добавьте их в Environment Variables Render.
4. Не добавляйте эти секреты в GitHub.

## Render

Вариант через GitHub:

1. Создайте новый GitHub repository.
2. Загрузите содержимое этой папки.
3. Не загружайте `.env`, `database.sqlite`, `public/uploads` и `public/avatars`.
4. В Render выберите New → Web Service.
5. Подключите GitHub repository.
6. Build Command: `npm install`.
7. Start Command: `npm start`.
8. План: Free.
9. Добавьте переменные окружения.
10. Deploy.

После запуска проверьте `/api/health`.

## Перенос старой SQLite-базы

Если нужно сохранить старые аккаунты/друзей/сообщения:

1. Положите старый `database.sqlite` в корень проекта локально.
2. Заполните `.env` значением `DATABASE_URL` от Neon.
3. Выполните:

```bash
npm install
node migrate-sqlite-to-postgres.js
```

Скрипт переносит доступные таблицы и сохраняет ID.

Важно: старые локальные файлы из `public/uploads` не становятся автоматически постоянными на Render. Их нужно отдельно загрузить в Cloudinary и заменить пути в БД. Новые файлы уже работают через Cloudinary.

## Ограничения бесплатной схемы

Free Render засыпает после периода без входящего трафика и может перезапускаться; это нормально для бесплатного хостинга. База и медиа при этом не зависят от локальной файловой системы Render.

Cloudinary Free имеет ограничения по размеру файлов и месячному использованию. В проекте поэтому видео/аудио ограничены 100 MB, изображения и обычные файлы — 10 MB.

Neon Free имеет ограниченный объём PostgreSQL и compute. Для 15–20 пользователей и текстовых сообщений этого достаточно при умеренном использовании.
