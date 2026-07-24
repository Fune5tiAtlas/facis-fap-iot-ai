-- NF-7 TCK transfer-process fixtures (audit 2026-07-24).
-- Seeds the FINALIZED contract agreements the DSP TCK's TP_01/TP_02/TP_03
-- provider tests expect (ATP0101..ATP0301, HttpData-PULL). Apply ONLY to a
-- dedicated IAM=off TCK connector instance's Postgres (never prod) BEFORE the
-- pod boots (the connector restores dsp_negotiations -> global.negotiations on
-- start); or apply live and restart the pod. The connector's transfer path
-- resolves an agreement by `doc->>'agreementId'` + state FINALIZED; with
-- IAM=off the counterparty check is bypassed, so these minimal records suffice.
INSERT INTO dsp_negotiations (id, state, doc) VALUES
  ('neg-tck-ATP0101', 'FINALIZED', '{"id":"neg-tck-ATP0101","state":"FINALIZED","agreementId":"ATP0101","counterparty":"did:web:tck","offerId":"offer:tck:CAT0101:read","assetId":"CAT0101","format":"HttpData-PULL"}'),
  ('neg-tck-ATP0102', 'FINALIZED', '{"id":"neg-tck-ATP0102","state":"FINALIZED","agreementId":"ATP0102","counterparty":"did:web:tck","offerId":"offer:tck:CAT0102:read","assetId":"CAT0102","format":"HttpData-PULL"}'),
  ('neg-tck-ATP0103', 'FINALIZED', '{"id":"neg-tck-ATP0103","state":"FINALIZED","agreementId":"ATP0103","counterparty":"did:web:tck","offerId":"offer:tck:CAT0103:read","assetId":"CAT0103","format":"HttpData-PULL"}'),
  ('neg-tck-ATP0201', 'FINALIZED', '{"id":"neg-tck-ATP0201","state":"FINALIZED","agreementId":"ATP0201","counterparty":"did:web:tck","offerId":"offer:tck:CAT0101:read","assetId":"CAT0101","format":"HttpData-PULL"}'),
  ('neg-tck-ATP0202', 'FINALIZED', '{"id":"neg-tck-ATP0202","state":"FINALIZED","agreementId":"ATP0202","counterparty":"did:web:tck","offerId":"offer:tck:CAT0102:read","assetId":"CAT0102","format":"HttpData-PULL"}'),
  ('neg-tck-ATP0301', 'FINALIZED', '{"id":"neg-tck-ATP0301","state":"FINALIZED","agreementId":"ATP0301","counterparty":"did:web:tck","offerId":"offer:tck:CAT0103:read","assetId":"CAT0103","format":"HttpData-PULL"}')
ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, doc = EXCLUDED.doc;
