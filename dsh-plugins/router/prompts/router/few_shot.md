每条：用户的话 → 应该输出的 JSON（reason 省略）。

用户：做一把木镐
{"slots":{"domain":{"value":"minecraft","confidence":0.98,"payload":null},"knowledge":{"value":"none","confidence":0.97,"payload":null},"action":{"value":"execute","confidence":0.95,"payload":{"instruction":"做一把木镐"}},"artifact":{"value":"none","confidence":0.99,"payload":null}},"clarification":null}

用户：岩浆会点燃玩家，记住这一点
{"slots":{"domain":{"value":"minecraft","confidence":0.98,"payload":null},"knowledge":{"value":"fact","confidence":0.93,"payload":{"statement":"岩浆会点燃玩家"}},"action":{"value":"none","confidence":0.95,"payload":null},"artifact":{"value":"none","confidence":0.97,"payload":null}},"clarification":null}

用户：熔炉烧一个物品要 10 秒，帮我把背包里的铁矿都烧了
{"slots":{"domain":{"value":"minecraft","confidence":0.99,"payload":null},"knowledge":{"value":"fact","confidence":0.88,"payload":{"statement":"熔炉烧一个物品要 10 秒"}},"action":{"value":"execute","confidence":0.94,"payload":{"instruction":"把背包里的铁矿都烧了"}},"artifact":{"value":"none","confidence":0.98,"payload":null}},"clarification":null}

用户：你好呀！对了，铁镐才能挖钻石矿
{"slots":{"domain":{"value":"minecraft","confidence":0.95,"payload":null},"knowledge":{"value":"fact","confidence":0.9,"payload":{"statement":"铁镐才能挖钻石矿"}},"action":{"value":"none","confidence":0.95,"payload":null},"artifact":{"value":"none","confidence":0.98,"payload":null}},"clarification":null}

用户：钻石一般在第几层？
{"slots":{"domain":{"value":"minecraft","confidence":0.98,"payload":null},"knowledge":{"value":"none","confidence":0.9,"payload":null},"action":{"value":"none","confidence":0.95,"payload":null},"artifact":{"value":"none","confidence":0.99,"payload":null}},"clarification":null}

用户：你现在背包里有什么？
{"slots":{"domain":{"value":"minecraft","confidence":0.97,"payload":null},"knowledge":{"value":"none","confidence":0.97,"payload":null},"action":{"value":"none","confidence":0.92,"payload":null},"artifact":{"value":"none","confidence":0.99,"payload":null}},"clarification":null}

用户：今天天气怎么样
{"slots":{"domain":{"value":"general","confidence":0.97,"payload":null},"knowledge":{"value":"none","confidence":0.98,"payload":null},"action":{"value":"none","confidence":0.98,"payload":null},"artifact":{"value":"none","confidence":0.99,"payload":null}},"clarification":null}

用户：要不要去挖点铁呢
{"slots":{"domain":{"value":"minecraft","confidence":0.96,"payload":null},"knowledge":{"value":"none","confidence":0.95,"payload":null},"action":{"value":"unknown","confidence":0.5,"payload":{"instruction":"去挖点铁"}},"artifact":{"value":"none","confidence":0.98,"payload":null}},"clarification":"是要我现在就去挖铁，还是只是商量一下？"}

用户：以后血量低于 5 就先吃东西
{"slots":{"domain":{"value":"minecraft","confidence":0.97,"payload":null},"knowledge":{"value":"none","confidence":0.9,"payload":null},"action":{"value":"none","confidence":0.85,"payload":null},"artifact":{"value":"fast_tree","confidence":0.9,"payload":{"intent":"血量低于 5 时先吃东西"}}},"clarification":null}

用户：别做了，停下来
{"slots":{"domain":{"value":"minecraft","confidence":0.93,"payload":null},"knowledge":{"value":"none","confidence":0.98,"payload":null},"action":{"value":"none","confidence":0.9,"payload":null},"artifact":{"value":"none","confidence":0.98,"payload":null}},"clarification":null}

[PENDING_CLARIFICATION] steveX 追问了：「是要我现在就去挖铁，还是只是商量一下？」用户当时的原话：「要不要去挖点铁呢」
用户：现在就去，挖 10 个
{"slots":{"domain":{"value":"minecraft","confidence":0.98,"payload":null},"knowledge":{"value":"none","confidence":0.97,"payload":null},"action":{"value":"execute","confidence":0.95,"payload":{"instruction":"去挖 10 个铁"}},"artifact":{"value":"none","confidence":0.99,"payload":null}},"clarification":null}

[PENDING_CLARIFICATION] steveX 追问了：「是要我现在就去挖铁，还是只是商量一下？」用户当时的原话：「要不要去挖点铁呢」
用户：先不用了
{"slots":{"domain":{"value":"minecraft","confidence":0.95,"payload":null},"knowledge":{"value":"none","confidence":0.97,"payload":null},"action":{"value":"none","confidence":0.92,"payload":null},"artifact":{"value":"none","confidence":0.99,"payload":null}},"clarification":null}
