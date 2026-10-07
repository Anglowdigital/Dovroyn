-- Gidgee & Co E-Commerce Schema

-- Categories for products
CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  image_url text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Products
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  short_description text,
  price numeric(10,2) NOT NULL DEFAULT 0,
  sale_price numeric(10,2),
  cost_price numeric(10,2),
  sku text,
  inventory_count integer DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','coming_soon','sold_out','archived')),
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  featured boolean DEFAULT false,
  tags text[],
  weight_grams integer,
  meta_title text,
  meta_description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Product images
CREATE TABLE IF NOT EXISTS public.product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  alt_text text,
  sort_order integer DEFAULT 0,
  is_primary boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Contact form submissions
CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text NOT NULL,
  phone text,
  subject text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','replied','archived')),
  created_at timestamptz DEFAULT now()
);

-- Newsletter subscribers
CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  first_name text,
  subscribed boolean DEFAULT true,
  source text DEFAULT 'website',
  created_at timestamptz DEFAULT now()
);

-- Product interest / notify me (for coming soon products)
CREATE TABLE IF NOT EXISTS public.product_interests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  message text,
  notified boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(product_id, email)
);

-- Enable Row Level Security
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_interests ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Everyone can read active products/categories
CREATE POLICY "Allow public read active products" ON public.products
  FOR SELECT USING (status IN ('active','coming_soon','sold_out'));

CREATE POLICY "Allow public read categories" ON public.categories
  FOR SELECT USING (true);

CREATE POLICY "Allow public read product images" ON public.product_images
  FOR SELECT USING (true);

-- Only authenticated users can write (insert/update/delete)
CREATE POLICY "Allow authenticated insert contacts" ON public.contacts
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow authenticated insert newsletter" ON public.newsletter_subscribers
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow authenticated insert product interests" ON public.product_interests
  FOR INSERT WITH CHECK (true);

-- Admin policies (for authenticated admin users)
CREATE POLICY "Allow admin full access products" ON public.products
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Allow admin full access categories" ON public.categories
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Allow admin full access product images" ON public.product_images
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Allow admin full access contacts" ON public.contacts
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Allow admin full access newsletter" ON public.newsletter_subscribers
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Allow admin full access product interests" ON public.product_interests
  FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- Insert sample categories
INSERT INTO public.categories (name, slug, description, sort_order) VALUES
  ('Hats', 'hats', 'Premium Australian inspired hats for every occasion', 1),
  ('Art Prints', 'art-prints', 'Abstract and Australian art prints', 2),
  ('Storage Boxes', 'storage-boxes', 'Eco-friendly storage solutions', 3),
  ('Accessories', 'accessories', 'Hat accessories and care products', 4)
ON CONFLICT (slug) DO NOTHING;

-- Insert sample products (coming soon)
INSERT INTO public.products (name, slug, description, short_description, price, sale_price, status, category_id, featured, tags, sku) VALUES
  ('The Outback Wide Brim', 'outback-wide-brim', 'A classic wide-brim hat designed for the harsh Australian sun. Made from durable materials with a comfortable fit.', 'Premium wide-brim hat for sun protection', 89.99, NULL, 'coming_soon', (SELECT id FROM public.categories WHERE slug='hats'), true, ARRAY['hat','wide-brim','sun','outback'], 'GC-HAT-001'),
  ('The Bushwalker Bucket', 'bushwalker-bucket', 'A versatile bucket hat perfect for hiking and outdoor adventures. Lightweight and breathable.', 'Versatile bucket hat for outdoor adventures', 59.99, NULL, 'coming_soon', (SELECT id FROM public.categories WHERE slug='hats'), true, ARRAY['hat','bucket','hiking','outdoor'], 'GC-HAT-002'),
  ('Abstract Black and White Art Print', 'abstract-black-white-print', 'A striking abstract art print featuring bold black and white patterns. Perfect for modern Australian interiors.', 'Bold abstract art print for modern spaces', 42.90, 37.00, 'coming_soon', (SELECT id FROM public.categories WHERE slug='art-prints'), true, ARRAY['art','print','abstract','decor'], 'GC-ART-001'),
  ('Eco Storage Box - Medium', 'eco-storage-box-medium', 'A sustainable storage box made from recycled materials. Perfect for organizing your home or office.', 'Sustainable eco-friendly storage box', 34.99, NULL, 'coming_soon', (SELECT id FROM public.categories WHERE slug='storage-boxes'), false, ARRAY['storage','eco','box','organize'], 'GC-BOX-001'),
  ('The Station Akubra-Style', 'station-akubra-style', 'A traditional Australian-style hat with a classic cattleman crease. Timeless design for the modern rancher.', 'Classic Australian cattleman-style hat', 129.99, NULL, 'coming_soon', (SELECT id FROM public.categories WHERE slug='hats'), false, ARRAY['hat','akubra','cattleman','classic'], 'GC-HAT-003')
ON CONFLICT (slug) DO NOTHING;

