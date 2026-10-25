// Fill these in from Supabase → Project Settings → API.
// The "anon / publishable" key is safe to put on the website.
// NEVER put the "service_role / secret" key here. That one is only for the Pi.
const SUPABASE_URL = "https://qlfqgyrwrihwomadqjsh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_FdDJh9NuiThZ12q-v4693w_L2HZ3qRb";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
