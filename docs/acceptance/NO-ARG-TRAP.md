# ⚠ 别裸跑 `soak.sh`

```bash
# ❌ 这样会真的往窗口里写一条采样点
bash scripts/soak.sh

# ✅ 想看看用法：读这句就够了 —— 参数必须是这四个之一
#    sample | probe | report | install_cron

# ✅ 想验证逻辑：永远用沙箱
SOAK=/tmp/foo.jsonl SOAK_DAY0=/tmp/foo-day0.txt \
SOAK_VERDICT=/tmp/v.jsonl DOTD_ACCEPT_DIR=/tmp/acc \
  bash scripts/soak.sh report
```

原因在 `scripts/soak.sh:2467`：

```bash
case "${1:-sample}" in
```

`${1:-sample}` 的意思是「第一个参数，没有就用 `sample`」。
所以**不带任何参数 = 执行一次 sample = 往 `docs/acceptance/soak.jsonl` 追加一行**。

它不会报错，不会提示，不会问你要不要。它只是安静地多了一行。

这条已经咬到过我一次（第 108 轮，见 `soak-notes.md`）。
在那个 `:-sample` 被改成 `:-usage` 之前，这份文件就是替代护栏。
