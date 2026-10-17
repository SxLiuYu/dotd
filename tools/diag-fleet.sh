#!/bin/bash
node --import tsx -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/.dotd/dotd.db");
for (const r of db.prepare("SELECT id, dot_id, state, docker_container_id, endpoint, last_health_at, recreate_count, updated_at FROM containers").all())
  console.log(r);
'
echo "== docker 实况 =="
docker ps -a --filter "name=dotd-dot-dot1" --format "{{.Names}} {{.Status}}"
