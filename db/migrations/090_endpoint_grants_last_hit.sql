-- 090：endpoint_grants 补 last_hit_at（2026-10-17 修"LRU 按 id 序踢热授权"）。
-- 背景：§4.5 第一阀（enforceTierCap）对 approval_rules 按 last_hit_at 淘汰，
-- endpoint_grants 没有这一列，只能退化成 id 正序——结果是"先授权先淘汰"，
-- 天天在用的热授权反而先被 expired，冷授权躺着占位。
-- SQLite 支持 ALTER TABLE ADD COLUMN（默认值 NULL，不触发表重建），且
-- endpoint_grants 无依赖该列的索引/约束，加列零风险。
ALTER TABLE endpoint_grants ADD COLUMN last_hit_at TEXT;
