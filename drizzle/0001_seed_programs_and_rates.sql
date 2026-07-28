-- Canonical programs, their aliases, and the initial effective-dated rates.
-- Rates live in the database precisely so they are NOT hardcoded in code.
--
-- VERIFIED against Calculations!G2:L2 of Excellent_Staffing_2025-2026.xlsx:
--   ComHab 21, Respite 17, SHCH 38, SHR 18, DayHab 17, SDH 17.
-- Agency rates are inferred from the Ahivim sheet's own rate ladders
-- (Com Hab 25, Respite/Day Hab/Suppl Group Day Hab 19) and are confirmed by the
-- exact P/G ratios of 0.84 and 0.894737.

INSERT INTO "programs" ("code", "name", "is_group_capable") VALUES
  ('COM_HAB',            'Com Hab',                    false),
  ('RESPITE',            'Respite',                    false),
  ('SH_COM_HAB',         'Self-Hire Com Hab',          false),
  ('SH_RESPITE',         'Self-Hire Respite',          false),
  ('DAY_HAB',            'Day Hab',                    true),
  ('SUPP_GROUP_DAY_HAB', 'Supplemental Group Day Hab', true)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

INSERT INTO "program_aliases" ("program_id", "normalized_alias", "source_text", "status")
SELECT p."id", a."alias", a."source", 'approved'
FROM (VALUES
  ('COM_HAB',            'com hab',                             'Com Hab'),
  ('COM_HAB',            'comhab',                              'ComHab'),
  ('COM_HAB',            'ch',                                  'CH'),
  ('COM_HAB',            'community habilitation',              'Community Habilitation'),
  ('RESPITE',            'respite',                             'Respite'),
  ('RESPITE',            'resp',                                'Resp'),
  ('SH_COM_HAB',         'self hire com hab',                   'Self Hire Com Hab'),
  ('SH_COM_HAB',         'self hired com hab',                  'Self Hired Com Hab'),
  ('SH_COM_HAB',         'selfhire com hab',                    'SelfHire Com Hab'),
  ('SH_COM_HAB',         'shch',                                'SHCH'),
  ('SH_COM_HAB',         'sd self hired com hab',               'SD - Self Hired Com Hab'),
  ('SH_RESPITE',         'self hire respite',                   'Self Hire Respite'),
  ('SH_RESPITE',         'self hired respite',                  'Self Hired Respite'),
  ('SH_RESPITE',         'sd self hired respite',               'SD - Self Hired Respite'),
  ('SH_RESPITE',         'shr',                                 'SHR'),
  ('DAY_HAB',            'day hab',                             'Day Hab'),
  ('DAY_HAB',            'dayhab',                              'DayHab'),
  ('DAY_HAB',            'dh',                                  'DH'),
  ('SUPP_GROUP_DAY_HAB', 'supplemental group day hab',          'Supplemental Group Day Hab'),
  ('SUPP_GROUP_DAY_HAB', 'supplemental group day habilitation', 'Supplemental Group Day Habilitation'),
  ('SUPP_GROUP_DAY_HAB', 'suppl group day hab',                 'Suppl Group Day Hab'),
  ('SUPP_GROUP_DAY_HAB', 'group day hab',                       'Group Day Hab'),
  ('SUPP_GROUP_DAY_HAB', 'sdh',                                 'SDH')
) AS a("code", "alias", "source")
JOIN "programs" p ON p."code" = a."code"
ON CONFLICT ("normalized_alias") DO NOTHING;
--> statement-breakpoint

-- Effective-dated rates. effective_to NULL means "still in force".
-- Self-hire programs have no agency rate: their rows never convert, which the
-- workbook confirms (P/G is exactly 1.0 for every self-hire row).
INSERT INTO "program_rate_schedules"
  ("program_id", "effective_from", "effective_to", "agency_rate", "internal_rate", "notes")
SELECT p."id", DATE '2000-01-01', NULL, r."agency", r."internal", r."note"
FROM (VALUES
  ('COM_HAB',            25.0000, 21.0000, 'Verified: Calculations!G2 = 21; Ahivim P/G ratio 0.84 = 21/25.'),
  ('RESPITE',            19.0000, 17.0000, 'Verified: Calculations!H2 = 17; Ahivim P/G ratio 0.894737 = 17/19.'),
  ('SH_COM_HAB',           NULL,  38.0000, 'Verified: Calculations!I2 = 38. No agency rate; rows never convert.'),
  ('SH_RESPITE',           NULL,  18.0000, 'Verified: Calculations!J2 = 18. Imported rates above or below raise a rate exception.'),
  ('DAY_HAB',            19.0000, 17.0000, 'Verified: Calculations!K2 = 17; Ahivim P/G ratio 0.894737 = 17/19.'),
  ('SUPP_GROUP_DAY_HAB', 19.0000, 17.0000, 'Verified: Calculations!L2 = 17. Group rows carry groupSize x 17 or groupSize x 19.')
) AS r("code", "agency", "internal", "note")
JOIN "programs" p ON p."code" = r."code"
WHERE NOT EXISTS (
  SELECT 1 FROM "program_rate_schedules" s WHERE s."program_id" = p."id"
);
