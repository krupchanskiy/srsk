# SRSK Project — Comprehensive Research Report

**Date:** February 6, 2026  
**Researcher:** Claude Code  
**Project:** SRSK (Sri Rupa Seva Kunja) — Ashram Management System

---

## 1. GUEST PORTAL STRUCTURE

### Directory & Files

```
guest-portal/
├── index.html                      # Main profile page (78.9 KB)
├── login/
│   └── index.html                  # Login page (multimode)
├── auth-callback/
│   └── index.html                  # OAuth callback handler
├── reset-password/
│   └── index.html                  # Password reset
├── retreats.html                   # Guest retreat list (17.9 KB)
├── materials.html                  # Learning materials (28.7 KB)
├── materials-admin.html            # Admin materials editor (27.0 KB)
├── contacts.html                   # Ashram contacts (14.2 KB)
│
├── js/
│   ├── portal-config.js            # Supabase config
│   ├── portal-auth.js              # Auth logic (9.9 KB)
│   ├── portal-layout.js            # Header/i18n (19.0 KB)
│   ├── portal-data.js              # Data loading (26.0 KB)
│   └── portal-index.js             # Main page logic (44.0 KB)
│
└── css/
    └── portal.css                  # Portal styles
```

### Key Architecture

**Portal Configuration (portal-config.js)**
- **Supabase URL:** `https://llttmftapmwebidgevmg.supabase.co`
- **Anon Key:** Production key (full access for guests)
- **Storage Bucket:** `vaishnava-photos` (for profile photos)
- **Colors:**
  - Green: `#147D30`
  - Orange: `#FFBA47`
  - BG: `#F5F3EF`

**Supabase Client Setup:**
```javascript
window.portalSupabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);
```

---

## 2. AUTH FLOW — COMPLETE OVERVIEW

### Login/Auth Callback Flow

**1. Portal Login Page (`guest-portal/login/index.html`)**
- Dual-mode login:
  - **Password mode:** Email + password login (traditional)
  - **Magic link mode:** Email-only, Supabase sends login link
- Password reset form included
- Language switcher (RU/EN/HI)

**2. Auth Callback (`guest-portal/auth-callback/index.html`)**
- Triggered after magic link or password reset
- Flow:
  1. Waits 500ms for Supabase to process tokens from URL
  2. Calls `db.auth.getSession()` to validate
  3. Calls `PortalAuth.linkAuthUserToVaishnava()` to bind auth.user to vaishnavas record
  4. Checks `user_type = 'staff'` to decide redirect:
     - Staff → `https://srsk.rupaseva.com/`
     - Regular guest → `/guest-portal/`

**3. Auth Check (portal-auth.js)**

`checkGuestAuth()` function:
- Validates session exists
- Loads vaishnava data matching `auth.user.id`
- Selected fields:
  ```
  id, first_name, last_name, spiritual_name, email, phone,
  has_whatsapp, telegram, telegram_username, country, city,
  photo_url, user_type, spiritual_teacher, no_spiritual_teacher,
  birth_date, is_active, is_profile_public
  ```
- Returns null if account is disabled (`is_active = false`)
- Populates `window.currentGuest` global object
- Redirects to login if any error

**Magic Link Function (`sendMagicLink(email)`)**
- Checks if vaishnava exists with that email
- Calls Supabase auth magic link
- Handles "new user" vs "existing user" cases

**Logout Function**
- Calls `db.auth.signOut()`
- Clears `window.currentGuest`
- Redirects to `/login/`

---

## 3. SUPABASE EDGE FUNCTIONS

### send-invite Function

**Location:** `/supabase/functions/send-invite/index.ts`

**Purpose:** Admin-only function to send registration invites to vaishnavas

**Authentication:**
- Requires authorization header
- Checks caller is superuser OR has `manage_users` permission
- Uses service role key for admin operations

**Input:**
```javascript
{
  "email": "guest@example.com",
  "vaishnavId": "uuid"
}
```

**Process:**
1. Validates service role client
2. Checks caller permissions (superuser OR manage_users)
3. Verifies vaishnava exists and has no `user_id` yet
4. Sends invite via `admin.inviteUserByEmail()` with:
   - Redirect URL: `${SITE_URL}/guest-portal/auth-callback.html`
   - Custom data: `vaishnava_id`, `full_name`

**Output:**
```javascript
{ "success": true, "message": "Invite sent successfully" }
// OR
{ "error": "reason" }
```

**CORS Headers:** Allows all origins (development-friendly)

---

## 4. SUPABASE STORAGE SETUP

### Photo Bucket Configuration

**Bucket Name:** `vaishnava-photos`

**Photo Upload Function (`uploadPhoto(file, guestId)` in portal-data.js)**

**Process:**
1. File validation:
   - Max size: 5 MB (checked on client)
   - Must be image/* type
2. Cropper.js for editing:
   - Fixed 1:1 aspect ratio
   - 1000×1000px output
   - JPEG quality 0.95
3. Storage path structure:
   ```
   {guestId}/{guestId}_{Date.now()}.{ext}
   ```
4. Upload options:
   ```javascript
   {
     cacheControl: '3600',  // 1 hour cache
     upsert: true          // Overwrite if exists
   }
   ```
5. Returns public URL for storing in DB

**Storage in Database:**
- Column: `vaishnavas.photo_url`
- Stores full public URL from Supabase
- Updated via `updateProfile()` function

---

## 5. PHOTO UPLOAD & CROPPING FLOW (index.html)

### Photo Edit Workflow

**HTML Elements:**
- File input: `#edit-photo-input`
- Upload area: `#edit-photo-upload`
- Preview: `#edit-photo-preview`
- Cropper modal: `#cropModal`
- Cropper image: `#cropImage`
- Zoom slider: `#zoomRange`

**JavaScript Functions:**

1. **`initPhotoUpload()`** — Event listeners
   - Click upload area → triggers input click
   - File change → validates size/type → calls `openCropModal()`

2. **`openCropModal(imageSrc)`** — Initialize Cropper.js
   ```javascript
   new Cropper(cropImage, {
     aspectRatio: 1,
     viewMode: 2,
     dragMode: 'move',
     autoCropArea: 0.9,
     cropBoxResizable: false,  // Square only
     preview: '#cropPreview',
     zoom: (e) => {
       // Limit zoom 0.1x to 3x
     }
   });
   ```

3. **`saveCroppedPhoto()`** — Canvas to Blob
   ```javascript
   const canvas = cropper.getCroppedCanvas({
     width: 1000,
     height: 1000,
     imageSmoothingQuality: 'high'
   });
   
   canvas.toBlob((blob) => {
     photoFile = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
     // Update preview
   }, 'image/jpeg', 0.95);
   ```

4. **`handleProfileSave()`** — Save workflow
   - If `photoFile` exists:
     - Call `PortalData.uploadPhoto(photoFile, guest.id)`
     - Get public URL
     - Store in `profileData.photoUrl`
   - Call `PortalData.updateProfile(guestId, profileData)`
   - Update `window.currentGuest`
   - Refresh UI

### Profile Save Function (`updateProfile()`)

Updates vaishnavas table:
```
first_name, last_name, spiritual_name, phone, has_whatsapp,
telegram, country, city, spiritual_teacher, no_spiritual_teacher,
birth_date, photo_url, is_profile_public, updated_at
```

---

## 6. DATA LOADING ARCHITECTURE

### Parallel Loading (portal-data.js)

**Dashboard Load (`loadDashboardData(guestId)`)**
```javascript
Promise.all([
  getCurrentOrUpcomingRetreat(guestId),
  getUpcomingRetreats(guestId),
  getMaterials(),
  getAvailableRetreats()
]);

// Then conditionally load:
if (activeRetreat) {
  await Promise.all([
    getAccommodation(guestId, activeRetreat.retreat.id),
    getTransfers(activeRetreat.id)
  ]);
}
```

**Key Data Functions:**

1. **`getCurrentOrUpcomingRetreat(guestId)`**
   - First searches for retreat where dates bracket today
   - Falls back to nearest future retreat
   - Returns entire registration object with nested retreat

2. **`getAccommodation(guestId, retreatId)`**
   - Loads from residents table
   - Includes check_in/check_out dates
   - Nested: room → building

3. **`getTransfers(retreatRegistrationId)`**
   - guest_transfers table
   - Directions: arrival, arrival_retreat, departure_retreat, departure

---

## 7. CONFIG FILES

### Main Config (js/config.js)

**Environment Detection:**
```javascript
const isDev = hostname.includes('dev.') || hostname.includes('-dev');
```

**Two Environments:**
- **Production:** llttmftapmwebidgevmg.supabase.co
- **Development:** vzuiwpeovnzfokekdetq.supabase.co

**Global Setup:**
```javascript
window.CONFIG = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ENV: 'production' | 'development',
  IS_DEV: boolean,
  SUPABASE_SERVICE_ROLE_KEY: null
};

window.supabaseClient = window.supabase.createClient(...);
```

---

## 8. CI/CD & DEPLOYMENT

### GitHub Actions

**Status:** NO `.github/` directory found

**Current Deployment:**
- Manual or external CI (not in repo)
- Project is GitHub Pages (static site)
- Deployment from main branch likely automated by GitHub

### Build Process

**None** — This is vanilla JS + CDN libraries:
- Tailwind CSS CDN
- Supabase JS CDN
- Cropper.js CDN
- Google Fonts CDN

**No build step:** HTML files served directly

---

## 9. EMAIL & NOTIFICATION INFRASTRUCTURE

### Email Features

**Current Implementation:**
- Supabase Auth handles:
  - Magic link emails
  - Password reset emails
  - Invite emails (via `send-invite` function)
- Email addresses stored in:
  - `auth.users.email` (Supabase auth)
  - `vaishnavas.email` (redundant storage)

**Communication Channels Stored:**
- `vaishnavas.email` — Email address
- `vaishnavas.telegram` — Telegram username
- `vaishnavas.telegram_username` — Backup field
- `vaishnavas.phone` — Phone number
- `vaishnavas.has_whatsapp` — Boolean flag

### CRM Communication Types
(from js/crm-utils.js)
```javascript
COMMUNICATION_TYPES: ['call', 'whatsapp', 'telegram', 'email', 'note']
```

**No Custom Email Service:**
- No Mailgun, SendGrid, or custom SMTP
- Relies entirely on Supabase Auth emails

---

## 10. KEY DATABASE TABLES FOR GUEST PORTAL

```
vaishnavas
├── id (uuid)
├── user_id (uuid, nullable) ← links to auth.users.id
├── first_name
├── last_name
├── spiritual_name
├── email
├── phone
├── has_whatsapp
├── telegram
├── telegram_username
├── country
├── city
├── photo_url ← Supabase Storage URL
├── user_type ('guest' | 'staff')
├── spiritual_teacher
├── no_spiritual_teacher
├── birth_date
├── is_active
├── is_profile_public
└── updated_at

retreat_registrations
├── id
├── vaishnava_id
├── retreat_id
├── status ('guest' | 'team' | 'cancelled')
├── is_deleted
└── created_at

residents
├── id
├── vaishnava_id
├── room_id
├── retreat_id
├── check_in (DATE)
├── check_out (DATE)
└── status

guest_transfers
├── id
├── retreat_registration_id
├── direction ('arrival' | 'arrival_retreat' | 'departure_retreat' | 'departure')
├── flight_datetime (TIMESTAMPTZ)
├── flight_number
└── needs_transfer

retreats
├── id
├── name_ru, name_en, name_hi
├── start_date (DATE)
├── end_date (DATE)
├── description_ru, description_en, description_hi
└── image_url
```

---

## 11. SPECIAL DATE HANDLING

### TIMESTAMPTZ vs DATE

**Critical Issue:**
- `datetime-local` inputs save WITHOUT timezone info
- PostgreSQL TIMESTAMPTZ stores as UTC
- Reading adds misleading `+00:00` suffix
- **Solution:** Always `.slice(0, 16)` before `new Date()` to strip timezone

**Example from portal-data.js:**
```javascript
const today = new Date().toISOString().split('T')[0];

// When reading from TIMESTAMPTZ:
const dateStr = data.flight_datetime.slice(0, 10); // Remove +00:00
```

---

## 12. INTERNATIONALIZATION (i18n)

### Translation System

**Translation Keys:**
- Stored as data attributes: `data-i18n="key_name"`
- Loaded dynamically (implementation in portal-layout.js)
- Supported languages: RU, EN, HI

**Language Persistence:**
- Likely localStorage-based
- Switcher in login page and main portal

---

## 13. SUPABASE MIGRATIONS

### Migration Files

Located in `/supabase/` directory (106 files total):
- `001_schema.sql` — Initial schema
- `002_seed_recipes.sql` — Recipe data
- SQL-based, numbered sequentially
- Executed in order by Supabase CLI

**Key migrations for guest portal:**
- `013_retreats.sql` — Retreat tables
- `014_team.sql` — Team/staff data
- Later migrations for specific features

---

## 14. SECURITY & PERMISSIONS

### RLS (Row-Level Security)

**Current Auth:**
- Guests authenticated via `auth.users`
- Linked to `vaishnavas` via `user_id`
- RLS policies likely restrict:
  - Can only view/edit own vaishnavas record
  - Can view retreat data user is registered for

### Permissions

**Fine-grained Access:**
- `manage_users` permission checked by edge function
- `superuser` flag in vaishnavas table
- Checked before operations affecting other users

---

## 15. DEVELOPMENT & LOCAL SETUP

### Config Files for Local Dev

**js/config.js:**
- Detects `localhost` as production (intentional)
- Allows development Supabase project via `dev.` subdomain
- Falls back to production credentials on localhost

**serve.json:**
- Local dev server config
- Likely port 3000

---

## 16. MISSING/TODO ITEMS

### Not Yet Implemented

1. **No .github/workflows** — No automated CI/CD in repo
2. **No API documentation** — No OpenAPI/Swagger
3. **No TypeScript** — Only vanilla JS (except edge function)
4. **No unit tests** — No test files in guest-portal/
5. **No custom email templates** — Using Supabase defaults
6. **No Telegram bot** — Just storing usernames
7. **No admin panel for guest-portal** — Only materials-admin.html

### Known TODOs in Code

- `js/config.js` line 32: "TODO: Вставить service role key если нужен"

---

## SUMMARY TABLE

| Component | Status | Notes |
|-----------|--------|-------|
| Guest Portal | ✅ Active | Full CRUD for guest profiles |
| Photo Upload | ✅ Implemented | Cropper.js + Storage |
| Auth | ✅ Implemented | Magic links + password |
| Edge Functions | ✅ Implemented | send-invite function |
| Storage | ✅ Configured | vaishnava-photos bucket |
| Email Service | ⚠️ Limited | Supabase Auth only |
| CI/CD | ❌ None | Manual deployment |
| Tests | ❌ None | No test suite |
| Documentation | ✅ Partial | /docs/modules/guest-portal.md exists |

---

**End of Research Report**
