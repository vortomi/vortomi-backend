-- A company's admins rename their company and set its time zone from Ajustes. Everything
-- else of the company row (status, plan, fiscal data) stays with our team's console.
GRANT UPDATE (name, timezone) ON public.tenants TO tenant_scoped;
