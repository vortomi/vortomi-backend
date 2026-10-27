-- Combined variants (0029): company code may point a variant at the values of the product's
-- second and third types, as it already can for the first (0018). Counts stay trigger-only.
GRANT UPDATE (variant_type_2_id, option_2_id, variant_type_3_id, option_3_id) ON public.product_variants TO tenant_scoped;
