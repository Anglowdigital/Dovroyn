
ALTER TABLE private.social_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.social_credentials FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.reserve_content_day(UUID, DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_content_day(UUID, DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reserve_content_day(UUID, DATE) FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_content_day(UUID, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION public.reserve_content_day(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_content_day(UUID, DATE) TO authenticated;

DROP POLICY IF EXISTS "Allow public waitlist inserts" ON public.waitlist;
REVOKE INSERT ON TABLE public.waitlist FROM anon, authenticated;

