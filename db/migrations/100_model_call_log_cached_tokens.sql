-- 100：model_call_log.cached_prompt_tokens（2026-10-17，cache-aware switching 迁移）
--
-- 背景：迁移 PilotDeck 的 cache-aware switching 时发现 model_call_log 只记
-- prompt_tokens / completion_tokens，而"这枚 prompt 有多少 token 命中了 provider
-- 的提示缓存"这个量无处落账——它是 cache-aware 排序唯一需要的原始数据。
--
-- 语义约定（与 transport.ts 的 usageCacheRead 对齐）：
--   * NULL = 该 provider 不报缓存命中数（本地 Colibrì 这类没有缓存概念的引擎）；
--   * 0    = 报了，但一个都没命中；
--   * >0   = 命中的 prompt token 数。
-- 三者必须可区分，否则"不支持缓存"和"支持但没命中"会算出同一个命中率，
-- cache-aware 排序就会把没有缓存的端点判成"缓存最差"而永远排在后面。
--
-- ALTER TABLE ADD COLUMN 是 SQLite 的原生在线操作：只改 schema，不重写表数据，
-- 旧行自动补 NULL。ddl 风格遵循 D2（改表结构必须走迁移包）。

ALTER TABLE model_call_log ADD COLUMN cached_prompt_tokens INTEGER;
