/*
# Fix "Database error saving new user" during signup

The handle_new_user() trigger function was missing `SET search_path = public`,
which causes it to fail when Supabase Auth creates a new user. This is a known
Supabase issue with SECURITY DEFINER functions.

1. Changes
- Recreate handle_new_user() with `SET search_path = public`
- Add ON CONFLICT clause so re-running after a partial failure doesn't crash
- Use COALESCE for email and NULLIF for full_name to handle edge cases
- Recreate the trigger to pick up the new function

2. Security
- Function remains SECURITY DEFINER so it can insert into profiles table
  (which has RLS enabled) during the auth.users INSERT trigger
- search_path is explicitly set to public to prevent schema injection
*/

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    NULLIF(NEW.raw_user_meta_data->>'full_name', '')
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
