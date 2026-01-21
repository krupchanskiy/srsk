// Supabase Configuration
const SUPABASE_URL = 'https://llttmftapmwebidgevmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdHRtZnRhcG13ZWJpZGdldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzQ3MTksImV4cCI6MjA4NDQ1MDcxOX0.V0J4_5AFDxHH6GsD-eh4N7fTBMjexSxAkVp2LSfgHh0';

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper function to get current language
function getCurrentLang() {
    return localStorage.getItem('srsk_lang') || 'ru';
}

// Helper function to get localized name
function getLocalizedName(item, lang = getCurrentLang()) {
    return item[`name_${lang}`] || item.name_ru;
}

// Export for use in other scripts
window.db = supabase;
window.getCurrentLang = getCurrentLang;
window.getLocalizedName = getLocalizedName;
