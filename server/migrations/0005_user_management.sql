CREATE TABLE IF NOT EXISTS app_users (
  id bigserial PRIMARY KEY,
  username varchar(50) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('ADMIN', 'REVIEWER', 'USER')),
  password_hash varchar(500) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  must_change_password boolean NOT NULL DEFAULT true,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_users_status_idx ON app_users(status, id);
CREATE INDEX IF NOT EXISTS tasks_creator_id_idx ON tasks(created_by_user_id, id DESC);

INSERT INTO app_users(username, display_name, role, password_hash, must_change_password)
VALUES (
  'admin',
  '系统管理员',
  'ADMIN',
  'scrypt-v1.YXV0by1jbG93LWFkbWluIQ.H0k0pdnIz73LcskpQsVwP7TDdqbNQUQTO6xAVIx8EzwuLhs1yIMG9HVTWHIsta0DlgkzyJle37uMZx1YRci6Tg',
  true
)
ON CONFLICT (username) DO NOTHING;
