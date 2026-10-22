-- 180_image_base_tag.sql —— image_builds.pw_version 改名 base_image_tag（2026-10-22）
--
-- 为什么改
--   这一列记的是镜像 tag 的第一段。它原本确实是 playwright 版本号，而
--   exec-image/Dockerfile 的基座在 2026-10-21 已从
--   mcr.microsoft.com/playwright:v1.49.1-noble 换成 node:24-slim（commit 8937390），
--   仓库里已经没有任何 playwright。列名继续叫 pw_version 会让人以为
--   "1.49.1" 还是某个 playwright 版本，而它现在只是拼 tag 用的基座标识。
--   handoff §7.2 记的就是这件事：下次构建出来的 tag 还会叫 1.49.1-0.1.0。
--
-- 为什么用 RENAME COLUMN 而不是 ADD + 回填 + DROP
--   这一列没有索引、没有触发器、没被视图引用（实测 sqlite_master 里 image_builds
--   只有表自己一行），而 SQLite 3.53.4 支持 RENAME COLUMN（实测可用，表定义被直接改写）。
--   ADD+DROP 要走建临时表那套，风险比改名大得多。
--
-- 老数据怎么办
--   改名后历史行仍写着 '1.49.1'，那是真实的历史值（当时基座确实是 playwright 1.49.1），
--   不是脏数据，不改写。新构建写 'slim'。两者共存是有意且可读的：
--   这一列只参与 tag 推导与审计，不做等值筛选。
--
-- 排版（照 170_proactive.sql 的规矩）
--   ① 注释全部集中在文件开头 ② 注释块后先接一条无害语句把注释吸走
--   ③ 语句之间空一行
--   另：RENAME COLUMN 不是 ADD COLUMN，db/template.ts 的 buildSchemaScript() 会把它
--   归进 others（而非拼进建表语句），所以新库的重放顺序是“先按 030 建带
--   pw_version 的表、再改名”，终态一致（已实测，见 docs/goal-2026-10-22.md）。

SELECT 1;

ALTER TABLE image_builds RENAME COLUMN pw_version TO base_image_tag;

PRAGMA user_version=180;
