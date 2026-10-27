# skill：完善事实库

把从源码里确认过的事实写进事实库（`fact_write`），格式要求：

- **一条事实一件事**：一句话说清"游戏里是什么样"，不写"应该怎么做"
- **引用指向能直接看出这件事的那几行**：1–5 条 `{ file, lines: [start, end] }`，每条最多 80 行；`file` 用 `mc_source_search` 结果里的路径
- 写之前先 `fact_search`：库里已经有同一件事，就带 `replaces` 修订它，不要另起一个名字
- 名字小写点分（如 `damage.lava-sets-fire`）
