-- Demo agency user — password is Demo@Dashboard2026! (bcrypt 10 rounds)
INSERT INTO users (email, password_hash, role)
VALUES ('demo@agency.com', '$2a$10$dZOfYdcuQ7dbsV1G9luxNuFB8vyW3fbjAmYEWT1tEJo.0OwubFAiC', 'agency')
ON CONFLICT (email) DO NOTHING;
