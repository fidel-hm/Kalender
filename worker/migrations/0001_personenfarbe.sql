-- Fuegt bestehenden Datenbanken die Personenfarbe hinzu.
-- Bei frischen Installationen ist die Spalte schon in schema.sql enthalten.
ALTER TABLE users ADD COLUMN color TEXT NOT NULL DEFAULT '#1971c2';

-- Bereits vorhandene Personen reihum auf die Palette verteilen, damit nicht
-- alle dieselbe Farbe haben. Reihenfolge wie PALETTE in src/index.js.
UPDATE users SET color = CASE (id - 1) % 12
  WHEN  0 THEN '#1971c2'
  WHEN  1 THEN '#2f9e44'
  WHEN  2 THEN '#e8590c'
  WHEN  3 THEN '#6741d9'
  WHEN  4 THEN '#0c8599'
  WHEN  5 THEN '#c2255c'
  WHEN  6 THEN '#f08c00'
  WHEN  7 THEN '#099268'
  WHEN  8 THEN '#9c36b5'
  WHEN  9 THEN '#e03131'
  WHEN 10 THEN '#846358'
  ELSE         '#495057'
END;
