-- Payment checks (0057): whoever checks a payment writes down what arrived, and confirming records
-- who did it and when. Stock movements of an order already go through the INSERT grant of 0013.
GRANT UPDATE (received_amount, confirmed_at, confirmed_by) ON public.orders TO tenant_scoped;
