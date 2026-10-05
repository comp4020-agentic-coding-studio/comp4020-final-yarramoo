-- Profiles carry a short human-written background (studies/work, <= 600 chars) and interests
-- (<= 300 chars). The old free-form bio is folded into background where none is set; the bio
-- column stays but is no longer shown or edited.
ALTER TABLE users ADD COLUMN background TEXT;
ALTER TABLE users ADD COLUMN interests TEXT;
UPDATE users SET background = substr(trim(bio), 1, 600) WHERE background IS NULL AND bio IS NOT NULL AND trim(bio) <> '';
