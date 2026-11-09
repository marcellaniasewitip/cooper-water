-- Depots saved from the admin with "no polygon" stored a JSON null instead of SQL NULL, which made the
-- depot geofence check (ST_GeomFromGeoJSON) fail and drivers could not go online. Clear them.
UPDATE "depots" SET "geofence_polygon" = NULL WHERE jsonb_typeof("geofence_polygon") = 'null';
