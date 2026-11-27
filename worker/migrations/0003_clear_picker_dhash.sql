-- Google Photos Picker imports stored a "perceptual hash" sampled from JPEG header bytes. It is
-- nearly identical for every JPEG, so later picks matched earlier ones as near-duplicates.
-- Picker imports now store no dHash; clear the old values so they stop matching.
UPDATE photos SET perceptual_hash = NULL WHERE source = 'google_picker';
