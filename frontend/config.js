// Fill these in from Supabase → Project Settings → API.
// The "anon / publishable" key is safe to put on the website.
// NEVER put the "service_role / secret" key here. That one is only for the Pi.
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
