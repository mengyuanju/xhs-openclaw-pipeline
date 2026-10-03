# 页面功能与浏览器动作证据审计（2026-10-02）

这是动作贡献审计，PARTIAL 不代表整个功能通过；UI_FIXTURE使用HTTP假数据，UI_REAL_ISOLATED才操作临时真实服务，均不能宣称真实模型。

当前稳定清单 598 行；PARTIAL_BROWSER_PASS_EVIDENCE 577，NOT_APPLICABLE_CURRENT_UI 9，CONDITIONAL_LOCAL_UI_PASS_EVIDENCE 12。状态由执行TAP和真实UI证据合并产生，不据测试文件名判断通过。

最终统一浏览器运行 88 项，原始 87 通过、1 失败；同名后续定点复测后未解决失败 0。原日志为 reports/full-functional-2026-10-02/browser-final-complete-orchestrator.log；修复复测为 reports/full-functional-2026-10-02/reassignment-final-auto-close-retest.tap (PASS)。原始失败保留，没有冒称当次统一运行全部通过。

| 功能ID | 页面功能 | 动作证据 | 当前证据状态 |
| --- | --- | --- | --- |
| F-AUTH-001 | 正确账号密码登录及 next 返回地址 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN07(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F031(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-002 | 空值、错误账号或密码 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN01(PASS)<br>reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN07(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-003 | 连续失败触发登录限制 | reports/full-functional-2026-10-02/functional-boundary-supplement.json#BD01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-004 | 强制初始密码修改弹窗 | reports/full-functional-2026-10-02/functional-browser-retests.json#B012(PASS)<br>reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-005 | 强制修改：空值、旧初始密码、两次不一致 | reports/full-functional-2026-10-02/functional-browser-retests.json#B012(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-006 | 强制修改：有效新密码 | reports/full-functional-2026-10-02/functional-browser-retests.json#B012(PASS)<br>reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-007 | 强制修改：退出并切换账号 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-008 | 后台退出 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN06(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F069(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-009 | 会话自动续期、过期及多页并发 | tests/session-renewal-browser.test.mjs:278 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-010 | 个人信息读取 | reports/full-functional-2026-10-02/functional-browser-retests.json#B008(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-011 | 显示姓名编辑并保存 | tests/profile-name-boundary-browser.test.mjs:25<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B008(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-012 | 普通修改登录密码 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-013 | 管理员设置 / 更新永久删除二级密码 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A011(PASS)<br>reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-AUTH-014 | 非管理员访问二级密码功能 | reports/full-functional-2026-10-02/functional-boundary-supplement.json#BD02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-001 | 品牌、首页及作业中心重定向 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-002 | 展开 / 收起作业中心和报表子菜单 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-003 | 移动端展开 / 收起主导航 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN06(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-004 | 逐个导航入口及顶部面包屑 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-005 | ADMIN / REVIEWER / USER 导航差异 | reports/full-functional-2026-10-02/functional-browser-retests.json#B012(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-006 | 权限开关组合及直接输入受限 URL | reports/full-functional-2026-10-02/functional-browser-retests.json#B012(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-007 | 全局后台任务提醒打开 / 关闭 | tests/background-tasks-browser.test.mjs:83<br>tests/background-task-ownership-browser.test.mjs:149<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-008 | 后台任务查看任务 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-009 | 单项标已读 | tests/background-tasks-browser.test.mjs:120 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-010 | 全部标已读 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-011 | 后台历史折叠及跨账号隔离 | tests/background-tasks-browser.test.mjs:83<br>tests/background-task-ownership-browser.test.mjs:149<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-012 | 弹窗 Escape、遮罩、取消、焦点返回及忙碌状态 | tests/dialog-notification-browser.test.mjs:41<br>tests/work-mode-browser.test.mjs:248<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B001(PASS)<br>reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-NAV-013 | 错误 / 成功通知关闭与失败重试 | tests/dialog-notification-browser.test.mjs:41<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-001 | 我的作业 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-002 | 待审核分配 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-003 | 全部文案任务 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-004 | 待文案审核 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-005 | 生图中 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-006 | 图片初审与返修 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-007 | 历史交付池兼容路由 | reports/full-functional-2026-10-02/functional-compatibility-route-supplement.json#VR2(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-008 | 全部作业 | reports/full-functional-2026-10-02/functional-auth-nav-supplement.json#AN05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-009 | 废弃池 | tests/task-restoration-browser.test.mjs:84 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-VIEW-010 | 未知 view 与无中心服务配置 | tests/workbench-route-empty-browser.test.mjs:30<br>reports/full-functional-2026-10-02/functional-compatibility-route-supplement.json#VR1(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-001 | 刷新、读取失败重新读取 | tests/admin-task-discard-browser.test.mjs:196 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-002 | Query 关键词搜索 | tests/frontend-round3-browser.test.mjs:97<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-003 | #ID 与 Query ID 搜索 | reports/full-functional-2026-10-02/functional-browser-retests.json#B005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-004 | 词包名称筛选 | reports/full-functional-2026-10-02/functional-boundary-supplement.json#BD04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-005 | 排序全部选项 | reports/full-functional-2026-10-02/functional-browser-retests.json#B017(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B017(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-006 | 优先级来源筛选 | reports/full-functional-2026-10-02/functional-browser-retests.json#B017(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B017(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-007 | 管理员创建者筛选及姓名搜索 | reports/full-functional-2026-10-02/functional-list-filter-supplement.json#LF01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-008 | 管理员负责人筛选及姓名搜索 | reports/full-functional-2026-10-02/functional-list-filter-supplement.json#LF02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-009 | 创建者当前角色筛选 | reports/full-functional-2026-10-02/functional-list-filter-supplement.json#LF03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-010 | 任务全部状态筛选 | reports/full-functional-2026-10-02/functional-browser-retests.json#B017(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B017(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-011 | 最近变更日期起止及边界 | tests/frontend-refresh-browser.test.mjs:133<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B017(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B017(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-012 | 异常快捷筛选 | reports/full-functional-2026-10-02/functional-list-filter-supplement.json#LF04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-013 | 个人作业关系筛选 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-014 | 个人作业分类及返修细分 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-015 | 个人今天 / 昨天 / 7 天 / 30 天 / 自定义日期 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-016 | 清空全部筛选及清除日期 | tests/personal-workspace-browser.test.mjs:255<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B005(PASS)<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B017(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B017(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-017 | 保存当前常用视图 | reports/full-functional-2026-10-02/functional-browser-retests.json#B006(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-018 | 载入保存视图 | reports/full-functional-2026-10-02/functional-browser-retests.json#B006(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-019 | 删除保存视图 | reports/full-functional-2026-10-02/functional-browser-retests.json#B006(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-020 | Query 去重开关 | reports/full-functional-2026-10-02/report-supplement-results.json#RS03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-021 | 预览重复 Query 弹窗 | reports/full-functional-2026-10-02/report-supplement-results.json#RS03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-022 | 确认清理重复 Query | reports/full-functional-2026-10-02/report-supplement-results.json#RS03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-023 | 行内查看更多操作菜单 | tests/admin-task-discard-browser.test.mjs:131 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-024 | 单选 / 全选当前页 / 清除选择 | tests/admin-task-discard-browser.test.mjs:131<br>tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-025 | 批量分配 / 改派 | reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-026 | 批量重试 | tests/admin-task-discard-browser.test.mjs:196 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-027 | 批量废弃 | tests/admin-task-discard-browser.test.mjs:131 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-028 | 单条恢复废弃任务 | tests/task-restoration-browser.test.mjs:84 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-029 | 单条永久删除及二级密码 | tests/admin-task-discard-browser.test.mjs:196 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-030 | 批量永久删除及上限 | tests/admin-task-discard-browser.test.mjs:131 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-031 | 批量导出交付任务 | tests/admin-task-discard-browser.test.mjs:196 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-032 | 分页首页 / 上页 / 下页 / 尾页 | reports/full-functional-2026-10-02/functional-browser-retests.json#B005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-033 | 每页 20 / 50 / 100 及删除末页 | reports/full-functional-2026-10-02/functional-browser-retests.json#B005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-034 | 详情返回、刷新及 URL 状态恢复 | reports/full-functional-2026-10-02/functional-boundary-supplement.json#BD05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LIST-035 | 列表空态创建第一条与无匹配空态 | tests/admin-task-discard-browser.test.mjs:214 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-001 | 已加载词包概况、筛选进度和状态 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-002 | 刷新词包及读取失败重新读取 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-003 | 搜索词包名称、甲方批次和筛选人 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-004 | 全部词包状态选项筛选 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-005 | 加载更多词包 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-006 | 打开导入词包弹窗与取消 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-007 | 词包名称与32位甲方批次编号校验 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-008 | 粘贴Query文本与识别/重复计数 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-009 | 读取TXT与CSV文件及重新选择 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-010 | 读取XLSX工作表与Query列 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-011 | 标准表生产Query优先与下发Query回退 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-012 | 标准表按任务ID自动拆包 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-013 | 导入空值、损坏文件、超限及无效批次 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-014 | 创建词包并核对候选数据 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-015 | 导入失败、陈旧版本及重复提交 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-016 | 分配筛选弹窗读取与取消 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-017 | 选择多名可分配标注/质检人员 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-018 | 平均分配策略 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-019 | 按条数分配策略与数量校验 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-020 | 取消全部人员并收回待筛分配 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-021 | 保存分配并重新分配 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A008(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-022 | 分配无待筛、无账号及加载错误 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-023 | 打开筛选/查看Query及关闭 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-024 | 按Query或外部编号搜索并清空 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-025 | 明细七种筛选结果选项 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-026 | 虚拟Query列表滚动与继续加载 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-027 | 单选和选择已加载可筛Query | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-028 | 单行暂存通过与改判 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-029 | 单行暂存淘汰与改判 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-030 | 提交本批暂存筛选 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-031 | 批量通过并自动创建正式作业 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-032 | 填写筛选原因并批量淘汰 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F067(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-033 | 无效/重复/已产任务行只读门禁 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-034 | ADMIN/USER/REVIEWER筛选范围与直达权限 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-035 | 关闭带暂存决定的筛选弹窗 | tests/query-package-browser.test.mjs:83<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-036 | 废弃词包原因、空值和取消 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A010(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-037 | 确认废弃词包并保留已创建作业 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A010(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-038 | 永久删除影响预检及状态门禁 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A010(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-039 | 永久删除三项确认和失败处理 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A010(PASS)<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A011(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-040 | 永久删除确认与取消并核对正式作业 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A010(PASS)<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A011(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-QPK-041 | 列表/明细空态、载入中和处理中按钮 | tests/query-package-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-001 | 打开 / 取消创建笔记弹窗 | tests/creation-form-browser.test.mjs:63<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B004(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-002 | 单条 Query 创建 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-003 | 多行 / 分隔符约 100 条批量创建 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-004 | 空 Query、超长、重复和不可信内容 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-005 | 配图自动 / 3 / 4 / 5 页 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-006 | 创建流程说明及表单提交状态 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-007 | 管理员免文案审核开关 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-008 | 免审核生图后门禁（UI与后台组合） | tests/creation-form-browser.test.mjs:69 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CREATE-009 | 创建成功与接口 / 网络失败重试 | tests/creation-form-browser.test.mjs:63 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-001 | 单条首次分配及选择账号 | reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-002 | 人员搜索、清除选择、重新读取 | reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-003 | 改派账号并填写必填原因 | reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-004 | 分配 / 改派取消 | reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS01(PASS)<br>reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS02(PASS)<br>reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-005 | 批量分配 / 改派及部分失败 | reports/full-functional-2026-10-02/functional-assignment-supplement.json#AS03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-006 | 调整优先级：跟随系统 / 最高 / 高 / 普通 / 暂缓 / 暂停 | tests/task-priority-batch-browser.test.mjs:34<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-007 | 优先级原因空值校验 | tests/task-priority-batch-browser.test.mjs:34<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-008 | 优先级影响预览 | tests/task-priority-batch-browser.test.mjs:34<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-009 | 确认优先级与取消 | tests/task-priority-batch-browser.test.mjs:34<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B007(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ASSIGN-010 | 调整整个生产批次优先级 | tests/task-priority-batch-browser.test.mjs:34 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-001 | 打开任务详情及刷新 | reports/full-functional-2026-10-02/functional-browser-retests.json#B001(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F061(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-002 | 未分配 / 别人负责 / 已质检文案只读 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-003 | 文案 / 图片规划移动页签 | tests/image-plan-review-browser.test.mjs:130<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-004 | 机器原稿评分全部档位 | tests/copy-review-drafts-browser.test.mjs:129<br>tests/work-mode-browser.test.mjs:248<br>tests/frontend-refresh-browser.test.mjs:133 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-005 | 原稿 1 分评分并废弃 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-006 | 原稿 2 / 2.5 分编辑标题 | tests/copy-review-drafts-browser.test.mjs:129<br>tests/image-retry-rework-browser.test.mjs:111<br>tests/work-mode-browser.test.mjs:248<br>tests/frontend-refresh-browser.test.mjs:133 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-007 | 编辑正文及字数反馈 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-008 | 编辑标签 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-009 | 扣分原因多选及说明 | tests/copy-review-drafts-browser.test.mjs:129<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-010 | 人工修订稿评分及最终评分 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-011 | 保存评分，暂不提交 | tests/copy-review-drafts-browser.test.mjs:129 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-012 | 审核通过并进入后续流程 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-013 | 审核草稿自动保存及状态 | tests/copy-review-drafts-browser.test.mjs:129<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-014 | 草稿立即保存 | tests/copy-review-drafts-browser.test.mjs:129 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-015 | 恢复历史草稿 | tests/copy-review-drafts-browser.test.mjs:129 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-016 | 恢复正式版本 | tests/copy-review-drafts-browser.test.mjs:129 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-017 | 关闭 / 刷新有未提交修改 | tests/background-tasks-browser.test.mjs:83<br>tests/work-mode-browser.test.mjs:248<br>tests/frontend-refresh-browser.test.mjs:133 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-018 | 返工要求查看及历史质检反馈展开 | tests/copy-rework-browser.test.mjs:136<br>tests/secondary-assignment-feedback-browser.test.mjs:232<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-019 | 返工仅允许指定文案字段 | tests/copy-rework-browser.test.mjs:136 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-020 | 保存返工稿，暂不提交 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-021 | 返工稿提交强制复检 | tests/copy-rework-browser.test.mjs:136 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-022 | 质检建议废弃 / 废弃返工任务 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-023 | 重试文案与生图连续失败回退 | tests/image-retry-rework-browser.test.mjs:111 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-024 | AI 生成水印开关 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-COPY-025 | 下载资源 / 进入质检批次 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-001 | 规划上一页 / 下一页及边界 | tests/image-plan-review-browser.test.mjs:130<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-002 | 页类型选择与首图固定 | tests/image-plan-review-browser.test.mjs:188 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-003 | 规划标题、副标题编辑 | tests/copy-review-drafts-browser.test.mjs:129<br>tests/copy-rework-browser.test.mjs:136<br>tests/image-retry-rework-browser.test.mjs:111<br>tests/image-plan-review-browser.test.mjs:130 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-004 | 画面要点多行编辑 | tests/image-plan-review-browser.test.mjs:130 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-005 | 画面生成指令编辑 | tests/image-plan-review-browser.test.mjs:188 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-006 | 删除允许的规划页 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-007 | 自动匹配 / 自定义排版 | tests/image-plan-review-browser.test.mjs:188 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-008 | 自定义标题位置、主体位置、文字区域 | tests/image-plan-review-browser.test.mjs:188 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-009 | 文字对齐、留白及主体占比 | tests/image-plan-review-browser.test.mjs:188 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-010 | 补充布局要求 | tests/image-plan-review-browser.test.mjs:188 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-011 | 单独保存图片规划 | tests/copy-review-drafts-browser.test.mjs:129<br>tests/copy-rework-browser.test.mjs:136<br>tests/image-plan-review-browser.test.mjs:130<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-012 | 未保存规划差异定位 | tests/image-plan-review-browser.test.mjs:130 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-013 | 重新生成图片文案规划 | tests/background-tasks-browser.test.mjs:83<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-014 | 规划生成中关闭弹窗 | tests/background-tasks-browser.test.mjs:83 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-015 | 载入已完成规划结果 | tests/background-tasks-browser.test.mjs:83<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-016 | 规划生成失败 / 重试 | tests/copy-review-controls-browser.test.mjs:64 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PLAN-017 | 返修规划及提交门禁 | tests/copy-rework-browser.test.mjs:136<br>tests/image-retry-rework-browser.test.mjs:111<br>tests/image-plan-review-browser.test.mjs:130 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-001 | 逐页缩略图与当前成品展示 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-002 | 放大成品及图片来源链接 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-003 | 图片审核备注编辑 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-004 | 查看返修范围、问题页及文案字段 | tests/image-review-notes-browser.test.mjs:203<br>tests/secondary-assignment-feedback-browser.test.mjs:232<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-005 | 首次图片初审完成 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-006 | 图片返修提交强制复检 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-007 | 图片编辑期间集中处理修改 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-008 | 集中处理逐项采用 / 拒绝 / 暂不处理 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-009 | 一键采用已完成修改 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-010 | 一键拒绝已完成修改 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-011 | 取消未完成修改 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-012 | 集中处理应用选择及继续初审 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-013 | 集中处理刷新与稍后处理 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-014 | 旧图片评分、扣分原因和说明 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-IREVIEW-015 | 旧图片审核发起仅图片 / 仅文案 / 双返工 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-IREVIEW-016 | 图片任务废弃 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IREVIEW-017 | 从失败步骤继续 / 重试生图 / 重新生成 | tests/copy-review-controls-browser.test.mjs:64 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-001 | 打开 / 关闭及 Esc、焦点返回 | tests/secondary-assignment-feedback-browser.test.mjs:232<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-002 | 上一张 / 下一张及键盘导航 | tests/secondary-assignment-feedback-browser.test.mjs:232<br>tests/image-preview-browser.test.mjs:70<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-003 | 透明棋盘 / 浅色 / 深色预览背景 | tests/image-preview-browser.test.mjs:109 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-004 | 100%查看 / 完整显示 / 倍数滑杆 | tests/image-preview-browser.test.mjs:70<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-005 | 放大后原生滚动查看边缘 | tests/image-preview-browser.test.mjs:108 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-006 | 左 / 右旋转 | tests/image-preview-browser.test.mjs:109<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-007 | 恢复预览 | tests/image-preview-browser.test.mjs:109 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-008 | 查看处理前源图 | tests/image-preview-browser.test.mjs:109 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-009 | 加载失败重试 | tests/image-preview-browser.test.mjs:109 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-010 | 下载当前图片与打开原图 | tests/image-preview-browser.test.mjs:109 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-011 | 历史版本选择与并列对比 | tests/history-knowledge-failure-browser.test.mjs:42 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IPREVIEW-012 | 恢复历史格式与背景参数 | tests/history-knowledge-failure-browser.test.mjs:42 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-001 | 添加文字 / 实体替换 / 局部修改页签 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-002 | 当前图 / 修改预览 / 前后对比 | tests/performance-round2-app-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-003 | 预览 / 编辑 / 记录移动页签与桌面面板 | tests/current-image-editor-browser.test.mjs:101<br>tests/current-image-editor-layout-browser.test.mjs:49 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-004 | 预览缩放与前后对比滑块 | tests/current-image-editor-browser.test.mjs:150 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-005 | 添加文字：程序叠加与图片模型融合 | tests/background-tasks-browser.test.mjs:83<br>tests/background-task-ownership-browser.test.mjs:149<br>tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-006 | 添加文字：描边 / 实心徽章 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-007 | 程序配色：自动 / 自定义 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-008 | 程序配色：取色器与颜色值 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-009 | 程序配色：屏幕取色 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-010 | 人工标识文字与最近常用 | tests/background-tasks-browser.test.mjs:83<br>tests/background-task-ownership-browser.test.mjs:149<br>tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-011 | 标识应用逐页选择 / 全选 / 清空 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-012 | 标识逐页预览 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-013 | 程序标识提交 | tests/background-tasks-browser.test.mjs:83<br>tests/background-task-ownership-browser.test.mjs:149<br>tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-014 | 模型标识费用确认及提交 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-015 | 标识批次状态及一次采用 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-016 | 真实产品参考图上传 / 更换 / 移除 | tests/current-image-editor-browser.test.mjs:101<br>tests/current-image-editor-browser.test.mjs:555<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-017 | 添加第二至第四产品与移除 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-018 | 严格完整产品 / 外观参考模式 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-019 | 产品逐页应用、切页及框选 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-020 | 只替换一个 / 框内全部同款 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-021 | 目标物品说明及重新框选 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-022 | 产品费用确认并提交单图 / 多图批次 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-023 | 产品替换执行前提醒 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-024 | 实体批次一次采用全部 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-025 | 局部修改点击目标定位 / 清除 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-026 | 局部修改动作选择 / 取消 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-027 | 局部修改补充要求与快捷要求 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-028 | 局部修改费用确认并提交 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-029 | 本次编辑 / 编辑记录切换及刷新 | tests/background-task-ownership-browser.test.mjs:149<br>tests/current-image-editor-browser.test.mjs:101<br>tests/current-image-editor-layout-browser.test.mjs:49<br>tests/standalone-image-editor-browser.test.mjs:73<br>tests/performance-round2-app-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-030 | 生成恢复历史图集预览 | tests/current-image-editor-browser.test.mjs:150 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-031 | 历史结果在左侧对比 / 打开结果 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-032 | 采用单条预览及必填操作原因 | tests/current-image-editor-browser.test.mjs:101<br>tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-033 | 拒绝预览及取消原因弹窗 | tests/current-image-editor-browser.test.mjs:150 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-034 | 取消排队 / 运行中修改 | tests/current-image-editor-browser.test.mjs:150 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-035 | 失败重试 / 定向修复 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-036 | 局部修改失败的替代描述方案 | tests/current-image-editor-browser.test.mjs:101 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-037 | 复用说明并修改 | tests/current-image-editor-browser.test.mjs:150 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-038 | 质量校验记录、失败原因和操作审计展开 | tests/current-image-editor-browser.test.mjs:101<br>tests/current-image-editor-layout-browser.test.mjs:49 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-039 | 背景运行后离开、返回及刷新 | tests/background-tasks-browser.test.mjs:83<br>tests/background-task-ownership-browser.test.mjs:149<br>tests/frontend-refresh-browser.test.mjs:133 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EDIT-040 | 只读 / 运行中工作空间 | tests/background-task-ownership-browser.test.mjs:149<br>tests/standalone-image-editor-browser.test.mjs:73<br>tests/performance-round2-app-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-001 | 图片列表加载、状态和失败原因 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-002 | 新增图片弹窗及名称 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-003 | 多图上传与进度 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-004 | 错误 MIME / 损坏 / 超限 / 错误尺寸图片 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-005 | 上传进行中的关闭和重复操作保护 | tests/standalone-image-editor-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-006 | 完成上传及逐页按钮 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-007 | 查看 / 编辑已有工作空间 | tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-008 | 独立工作空间修改结果采用 | tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-009 | 运行中查看限制 | tests/standalone-image-editor-browser.test.mjs:73 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-010 | 列表刷新及 20 条分页 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-011 | 单条删除与取消确认 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-012 | 本页单选 / 全选与批量删除取消、确认、失败 | tests/standalone-image-editor-browser.test.mjs:73<br>tests/standalone-boundary-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAND-013 | 编辑器载入失败重新加载 | tests/frontend-refresh-browser.test.mjs:133 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-001 | 文案审核 / 图片初审 / 文案质检 / 图片质检类型切换 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-002 | 文案质检分类：全部 / 第一次抽检 / 强制复检 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-003 | 待办刷新、重试和加载更多 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-004 | 已加载待办关键词搜索 | tests/work-mode-browser.test.mjs:198 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-005 | 展开 / 收起待办侧栏 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-006 | 点击队列任务及 URL 直接定位 | tests/secondary-assignment-feedback-browser.test.mjs:232<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-007 | 暂跳过 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-008 | 保存草稿与导航确认 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-009 | 审核 / 质检提交并下一条 | tests/image-review-notes-browser.test.mjs:203<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-010 | 本次已提交记录展开 / 收起 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-011 | 文案质检规划翻页 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-012 | 图片质检缩略图、背景、放大及当前页问题标记 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-013 | 强制复检上次退回说明 | tests/secondary-assignment-feedback-browser.test.mjs:232<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-014 | 质检打回表单及返回核验 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-015 | 质检通过并下一条 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-016 | 复检提交管理员 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-017 | 质检废弃图片任务 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-WORK-018 | 空队列刷新及权限变化 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-001 | 个人模式 / 混合模式页签 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-002 | 按用户列表查看待入批任务 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-003 | 选择用户任务与返回用户列表 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-004 | 入批单选 / 全选 | tests/frontend-followup-browser.test.mjs:110 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-005 | 质检项单选 / 全选 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-006 | 个人手动创建批次 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-007 | 按比例随机抽检并创建 | tests/frontend-followup-browser.test.mjs:110 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-008 | 混合手动创建批次 | tests/frontend-followup-browser.test.mjs:110 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-009 | 零选择、刷新及重复点击 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CFLOW-010 | 创建成功后进入文案质检 | tests/frontend-followup-browser.test.mjs:110 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-001 | 待质检 / 已完成批次切换 | tests/copy-qa-overview-browser.test.mjs:81<br>tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-002 | 列表刷新及 20 条分页 | tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-003 | 进入批次与返回列表 | tests/copy-qa-detail-browser.test.mjs:87<br>tests/copy-qa-overview-browser.test.mjs:81<br>tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-004 | 批次本页刷新及 50 条明细分页 | tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-005 | 查看并质检 / 查看文案 | tests/copy-qa-detail-browser.test.mjs:87<br>tests/copy-qa-overview-browser.test.mjs:81<br>tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-006 | 最终稿与逐页图片规划对照 | tests/copy-qa-detail-browser.test.mjs:87<br>tests/copy-qa-overview-browser.test.mjs:81<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-007 | 独立盲评 | tests/copy-qa-overview-browser.test.mjs:81 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-008 | 质检通过及确认取消 | tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-009 | 单条打回：原因标签分类展开 / 多选 | tests/copy-qa-reason-picker-browser.test.mjs:94<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-010 | 单条打回：说明及空原因校验 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-011 | 确认单条驳回 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-012 | 批次驳回率阈值及全量质检差异 | tests/copy-qa-discard-browser.test.mjs:48 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-013 | 废弃任务理由、必填说明及二次确认 | tests/copy-qa-discard-browser.test.mjs:48 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-014 | 已废弃详情及历史记录 | tests/copy-qa-discard-browser.test.mjs:48 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-CQA-015 | 重复提交 / 陈旧版本 / 自己审核样本 | tests/copy-qa-discard-browser.test.mjs:48 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-001 | 待质检 / 已通过 / 已打回 / 全部 / 已提交管理员 / 已废弃 | tests/image-quality-browser.test.mjs:189<br>tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-002 | 刷新、重新检查、返回待质检 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-003 | 管理员人员姓名 / 账号筛选及清除 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-004 | 上一页 / 下一页 | tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-005 | 查看图片弹窗及页缩略图 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-006 | 大图、背景和页码导航 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-007 | 盲评 / 非盲评信息 | tests/image-quality-browser.test.mjs:189 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-008 | 质检通过 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248<br>tests/frontend-followup-browser.test.mjs:85 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-009 | 打回评分 1 / 2 与返工范围 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-010 | 问题原因多选及具体修改要求 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-011 | 问题图片选择 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-012 | 返工文案标题 / 正文 / 标签 / 图片规划字段 | tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-013 | 确认单条打回与取消 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-014 | 整批图片打回 | tests/image-quality-browser.test.mjs:324 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-015 | 旧强制复检提交管理员动作 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-IQA-016 | 图片任务废弃 | tests/image-quality-browser.test.mjs:189<br>tests/work-mode-browser.test.mjs:248 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-IQA-017 | 陈旧图集 / 多人并发处置 | tests/image-quality-browser.test.mjs:357 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-001 | 待处理 / 已重新分配 / 已废弃 / 全部记录 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-002 | 刷新、重新加载及分页 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-003 | 查看处置 / 查看记录 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-004 | 重试还原 / 清理 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-005 | 缺少初稿重新生成初始数据 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-006 | 查看初始数据与分配记录 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-007 | 选择接手账号、账号载入失败重试 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-008 | 确认二次分配及原因校验 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-009 | 最终废弃与取消 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-010 | 撤销废弃恢复待二次分配 | tests/reassignment-batch-browser.test.mjs:361 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-011 | 本页单选 / 全选 / 清空 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-012 | 批量分配 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-013 | 批量重试还原 / 清理 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-014 | 批量废弃及取消 | tests/reassignment-batch-browser.test.mjs:146 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REASSIGN-015 | 二次分配后的新作业提示 | tests/secondary-assignment-feedback-browser.test.mjs:232 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-001 | 当前交付内容 / 交付记录含历史版本 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-002 | 全部 / 未交付 / 已交付 / 版本更新待重交卡片 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-003 | 交付状态全部选项筛选 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-004 | 日期依据选择与起止日期 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-005 | 今天 / 昨天 / 7 天 / 30 天 / 不限日期 | reports/full-functional-2026-10-02/functional-delivery-filter-supplement.json#DF01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-006 | 任务号 / Query / 批次号搜索 | tests/shared-delivery-filter-browser.test.mjs:35<br>reports/full-functional-2026-10-02/functional-delivery-filter-supplement.json#DF02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-007 | 版本情况筛选 | tests/shared-delivery-filter-browser.test.mjs:35<br>reports/full-functional-2026-10-02/functional-delivery-filter-supplement.json#DF03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-008 | 负责人 / 打包人 / 确认人筛选及清除 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-009 | 管理员汇总保存、精确词包名、甲方批次筛选 | tests/shared-delivery-filter-browser.test.mjs:35<br>reports/full-functional-2026-10-02/functional-delivery-filter-supplement.json#DF04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-010 | 选择本页 / 单选 / 清空 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-011 | 打包并下载 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-012 | 下载所选冻结内容 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-013 | 确认所选已交付 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-014 | 汇总保存已交付内容 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-015 | 选择全部筛选已交付结果 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-016 | 刷新与每 15 秒自动同步 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-017 | 分页及每页 20 / 50 / 100 | tests/shared-delivery-filter-browser.test.mjs:35<br>reports/full-functional-2026-10-02/functional-delivery-filter-supplement.json#DF05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-018 | 文件记录展开 / 收起与分页 | tests/shared-delivery-browser.test.mjs:90<br>tests/frontend-round3-browser.test.mjs:97 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-019 | 成功文件多卷下载 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-020 | 失败文件按原范围重试 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DELIVERY-021 | 版本更新 / 改派 / 删除后的历史交付 | tests/shared-delivery-browser.test.mjs:90 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-001 | 展开工具区及内容 / 预览上传 / 交付历史页签 | tests/legacy-delivery-browser.test.mjs:70<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B003(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F066(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-002 | 多行搜索、清除、甲方批次和交付状态 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-003 | 内容选择与加载更多 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-004 | 图文预览弹窗 | tests/legacy-delivery-browser.test.mjs:70<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B003(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F066(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-005 | 图文预览上一页 / 下一页 / 缩略图 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-006 | 导出已选 / 全部文章与图片 Excel | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-007 | 新建全部待交付 / 已选 / 单条批次 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-008 | 重下原批次 / 下载本条 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-009 | 预览上传范围搜索、勾选当前结果和清空 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-010 | 整包上传条数上限 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-011 | 上传这一条 / 上传已选 / 整包上传 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-012 | 已发布预览打开 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-013 | 交付历史查看明细、关闭和下载 | tests/legacy-delivery-browser.test.mjs:70<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B003(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F066(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-DLEGACY-014 | 交付门禁与测试任务隔离 | tests/legacy-delivery-browser.test.mjs:70 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-001 | 提示词目录搜索与选择 | tests/prompt-catalog-browser.test.mjs:59 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-002 | 分组选择、业务类型页签及快捷编辑 Query 规则 | tests/prompt-catalog-browser.test.mjs:59<br>tests/prompt-catalog-browser.test.mjs:124 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-003 | 页签键盘导航及切换保留编辑 | tests/prompt-catalog-browser.test.mjs:59<br>tests/prompt-catalog-browser.test.mjs:124 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-004 | 业务规则编辑与程序协议只读 | tests/prompt-catalog-browser.test.mjs:59 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-005 | 保存草稿 | tests/prompt-catalog-browser.test.mjs:59<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B002(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F065(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-006 | 提交更新 / 创建新版本并发布 | reports/full-functional-2026-10-02/functional-browser-retests.json#B002(PASS)<br>reports/full-functional-2026-10-02/functional-prompt-supplement.json#P002(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F065(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-007 | 放弃修改确认及取消 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P003(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-008 | 历史版本展开 / 载入编辑 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P003(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-009 | 本机重新发布历史版本 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-PROMPT-010 | 中心刷新、陈旧 baseId 冲突 | tests/prompt-catalog-browser.test.mjs:59<br>tests/prompt-catalog-browser.test.mjs:124 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-011 | 提示词优化约束提示 | tests/prompt-catalog-browser.test.mjs:88 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-012 | 预检及变量展开示例 Query | tests/prompt-catalog-browser.test.mjs:124<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B002(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F065(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-013 | 准备缺失候选草稿 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P001(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-014 | 启用 Query 筛选 / 视觉规划 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P002(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-015 | 案例入选分数及文案修复上下限 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P002(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-016 | OCR 最低置信度和比较方式 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P002(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-017 | 检查版本并启用统一规则 / 保存执行配置 | reports/full-functional-2026-10-02/functional-prompt-supplement.json#P002(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-018 | 执行记录位置、本机 / 中心选择与刷新最近 50 次 | tests/prompt-catalog-browser.test.mjs:124<br>reports/full-functional-2026-10-02/functional-prompt-supplement.json#P004(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PROMPT-019 | 打开执行记录 | tests/prompt-catalog-browser.test.mjs:124<br>reports/full-functional-2026-10-02/functional-prompt-supplement.json#P004(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-001 | 知识库使用总开关 | reports/full-functional-2026-10-02/functional-100-results.json#F068(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-002 | 新增文案分析弹窗与取消 | reports/full-functional-2026-10-02/functional-browser-retests.json#B010(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-003 | 优秀文案及分析 Prompt 输入 | reports/full-functional-2026-10-02/functional-browser-retests.json#B010(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-004 | 载入已保存分析 Prompt | reports/full-functional-2026-10-02/functional-browser-retests.json#B020(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B020(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-005 | 保存新的分析 Prompt | reports/full-functional-2026-10-02/functional-browser-retests.json#B020(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B020(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-006 | 同类 Prompt 替换目标选择及确认 | tests/knowledge-analysis-browser.test.mjs:36 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-007 | 调用模型分析并自动入库 | tests/knowledge-analysis-browser.test.mjs:36 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-008 | 全部 / 分类标签及展开更多标签 | reports/full-functional-2026-10-02/functional-browser-retests.json#B009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-009 | 分析标题搜索 | reports/full-functional-2026-10-02/functional-browser-retests.json#B009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-010 | 查看分析详情与关闭 | reports/full-functional-2026-10-02/functional-browser-retests.json#B009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-011 | 编辑分析各字段并保存 | reports/full-functional-2026-10-02/functional-browser-retests.json#B009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-012 | 编辑取消 / 无效内容 | reports/full-functional-2026-10-02/functional-browser-retests.json#B009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-013 | 删除文案分析确认与取消 | reports/full-functional-2026-10-02/functional-browser-retests.json#B009(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-014 | 每页 10 / 20 / 50 与分页 | reports/full-functional-2026-10-02/functional-boundary-supplement.json#BD03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-KNOW-015 | 读取失败重新加载 | tests/history-knowledge-failure-browser.test.mjs:42 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-001 | 生成与模型 / 质量与审核 / 图片与输出 / 兼容与高级 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-100-results.json#F064(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-002 | 搜索主服务：继承 / 豆包 / DeepSeek / Codex | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-003 | 备用搜索新增 / 移除 / 上移 / 下移 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-004 | DeepSeek 搜索模型、超时及来源数量 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B013(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B013(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-005 | 豆包 Custom / Global 及 ICP 范围 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-006 | 搜索恢复环境 / 首次读取失败重新读取 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B013(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B013(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-007 | 保存搜索配置及失败恢复 | reports/full-functional-2026-10-02/functional-browser-retests.json#B013(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B013(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-008 | 小红书搜索开关及关闭确认 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-009 | 小红书极速 / 深度排序模式 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-010 | 小红书链接数、最短间隔、60 分钟 / 24 小时限额 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-011 | 小红书恢复默认节奏 / 保存 / 重新读取 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-012 | 文案提供方继承 / Codex / Dots | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-013 | Dots API 地址与模型 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-014 | 文案思考强度全部选项 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-015 | 文本生成模型选择 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-016 | 需求检测模型选择 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-017 | 阶段审核模型选择 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-018 | 视觉验收模型选择 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-019 | 独立终审模型选择 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-020 | 图片生成模型选择 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-021 | 容量备用模型与主模型满载冷却 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-022 | 文本视觉代理 / 图片代理 / 图片调用超时 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-023 | 恢复环境配置及保存模型配置 | tests/production-settings-browser.test.mjs:86 | CONDITIONAL_LOCAL_UI_PASS_EVIDENCE |
| F-SETTING-024 | 流程文案抽检开关 / 独立盲评 / 默认比例 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-025 | 文案批次自动驳回阈值 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-026 | 图片抽检开关 / 盲评 / 比例 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-027 | 允许质检员整批图片打回 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-028 | 流程撤销 / 重新读取 / 保存 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-029 | 评分档位名称、说明及显示开关 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-030 | 文案 / 图片扣分原因及展示开关 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-031 | 文案 / 图片评分说明占位提示 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-032 | 保存人工评分标准 | tests/settings-remaining-browser.test.mjs:75<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-033 | 自动返修开关、触发分数、目标分数和 0–2 次 | tests/production-settings-browser.test.mjs:50 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-034 | 保存返修策略 | tests/production-settings-browser.test.mjs:50 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-035 | 布局模板搜索、分类、启用状态 | tests/settings-catalog-controls-browser.test.mjs:110<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B016(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B016(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-036 | 布局模型规划 / 匹配随机选择方式 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-037 | 布局模板启用 / 禁用 | tests/settings-catalog-controls-browser.test.mjs:110<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B016(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B016(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-038 | 编辑布局新版本 / 取消 | tests/settings-catalog-controls-browser.test.mjs:110<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B016(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B016(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-039 | 保存布局新版本 | tests/settings-catalog-controls-browser.test.mjs:110<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B016(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B016(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-040 | 批量导入模板 JSON 文件 / 文本 | tests/settings-catalog-controls-browser.test.mjs:110<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B016(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B016(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-041 | 导入内置 27 模板与查看当前 JSON | tests/settings-catalog-controls-browser.test.mjs:110<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B016(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B016(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-042 | 模型生成布局候选并自动入库 | tests/settings-policy-branches-browser.test.mjs:75 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-043 | 图片模型标识单次生成说明 | tests/production-settings-browser.test.mjs:50 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-044 | AI 生成标识开关 / 文字及保存交付配置 | tests/production-settings-browser.test.mjs:50 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-045 | 旧版布局添加 / 编辑 / 参与随机 / 删除 | tests/settings-catalog-controls-browser.test.mjs:350<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B015(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B015(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-046 | 保存旧版布局配置 | tests/settings-catalog-controls-browser.test.mjs:350<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B015(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B015(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-047 | 中心其他配置 JSON 保存新版本 | reports/full-functional-2026-10-02/functional-browser-retests.json#B015(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B015(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-SETTING-048 | 各分区未保存提示、忙碌禁用和重新读取 | tests/settings-remaining-browser.test.mjs:75<br>tests/settings-catalog-controls-browser.test.mjs:110<br>tests/settings-catalog-controls-browser.test.mjs:350<br>reports/full-functional-2026-10-02/functional-100-results.json#F064(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-001 | 账号与权限 / 自动分配池页签及顶部概览 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A004(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-002 | 用户姓名 / 账号搜索、角色 / 状态筛选和分页 | reports/full-functional-2026-10-02/functional-browser-retests.json#B011(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-003 | 新增用户基础信息 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A001(PASS)<br>reports/full-functional-2026-10-02/functional-100-results.json#F063(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-004 | 新增重复 / 无效账号与取消 | reports/full-functional-2026-10-02/functional-browser-retests.json#B011(PASS)<br>reports/full-functional-2026-10-02/functional-admin-supplement.json#A001(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-005 | 编辑姓名、角色、启用 / 停用状态 | tests/account-copy-sampling-browser.test.mjs:66<br>reports/full-functional-2026-10-02/functional-100-results.json#F063(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-006 | 文案审核权限开关 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-007 | 文案质检权限开关 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-008 | 图片质检权限开关 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-009 | 账号文案抽检继承 / 单独配置 | tests/account-copy-sampling-browser.test.mjs:66 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-010 | 自动文案成批开关和 1–5000 数量 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-011 | 文案全量质检 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A014(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-012 | 更多菜单重置密码与取消 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A002(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-013 | 删除用户与取消 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A006(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-014 | 解除登录限制与确认 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A003(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-015 | 分配池持续补位 / 定量模式切换 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-016 | 分配总开关开启 / 关闭 | tests/user-auto-assignment-browser.test.mjs:80 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-017 | 加入标注：搜索 / 人员选择 / 取消 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A004(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-018 | 加入标注并设置上限 / 数量 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A004(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-019 | 编辑成员上限 / 单次数量 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-020 | 暂停 / 恢复接单 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-021 | 移出人员池确认与取消 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A005(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-022 | 定量分配按钮 | tests/user-auto-assignment-browser.test.mjs:80 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-023 | 持续补位行为 | tests/user-auto-assignment-browser.test.mjs:80 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-USER-024 | 池当前待审、可补、累计 / 今日定量记录 | tests/user-auto-assignment-browser.test.mjs:80 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-001 | 执行机列表与刷新 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A012(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-002 | 执行机并发、容量、执行器版本和状态 | reports/full-functional-2026-10-02/functional-statistics-supplement.json#ST06(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-003 | 删除离线且无有效执行机 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A012(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-004 | 在线 / 正在执行节点删除限制 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A012(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-005 | 小红书搜索节点登录与能力状态 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A013(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-006 | 移除小红书搜索节点 | reports/full-functional-2026-10-02/functional-admin-supplement.json#A013(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-EXEC-007 | 全局小红书账号异常提示 | tests/xhs-account-alert-browser.test.mjs:30 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-001 | 个人数据 / 作业数据页签、我的作业和刷新 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-002 | 今日概览及交付池入口 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-003 | 今日文案 / 图片质检通过详情 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-004 | 今天 / 昨天 / 7 天 / 自定义日期 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-005 | 个人文案标注首次 / 返修 / 废弃 / 提交指标 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-006 | 个人图片全部提交 / 首次审核 / 返修提交指标 | reports/full-functional-2026-10-02/functional-statistics-supplement.json#ST01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-007 | 个人质检次数、通过、退回、复检和整批影响 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-008 | 个人明细弹窗分页、时间线及打开任务 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-009 | 当前质检待办 / 暂不可处理 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-010 | 作业关系：我负责 / 我创建 / 与我相关 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-011 | 作业状态各卡片跳转 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-012 | 返修仅文案 / 仅图片 / 双返工 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-013 | 返修待修改 / 后台处理中 / 待确认 / 超 24 小时 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-014 | 我的交付记录弹窗 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PERSONAL-015 | 加载错误重试及过时数据提示 | tests/personal-workspace-browser.test.mjs:255 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-001 | 管理员总数据及标注作业报表入口 | tests/operator-performance-browser.test.mjs:107<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B019(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-002 | 今日 / 昨日 / 7 天 / 本月 / 30 天 / 自定义日期 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-003 | 人员、账号搜索、文案 / 图片筛选及应用 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-004 | 一次通过 / 打回 / 废弃质量卡片下钻 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-005 | 建议改派 / 待质检下钻 | reports/full-functional-2026-10-02/functional-browser-retests.json#B019(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-006 | 工作量与趋势展开 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-007 | 全部 / 标注 / 质检账号表现切换 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-008 | 列排序、移动排序及分页 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-009 | 人员姓名、指标、复检 / 通过 / 逐项退回下钻 | tests/operator-performance-browser.test.mjs:107<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B019(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-010 | 明细操作 / 质量与时效 / 趋势与待办页签 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-011 | 明细范围、阶段、结论筛选和分页 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-012 | 事件版本与处理时间线及当前任务链接 | tests/operator-performance-browser.test.mjs:171<br>reports/full-functional-2026-10-02/functional-statistics-supplement.json#ST05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-013 | 当前待办分页及返修等待时间 | reports/full-functional-2026-10-02/functional-statistics-supplement.json#ST04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-014 | 导出报表 | tests/operator-performance-browser.test.mjs:107<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B019(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-STAT-015 | 读取失败、超时和明细刷新提示 | tests/operator-performance-browser.test.mjs:107 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-001 | 任务池状态概览与刷新 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-002 | 开始 / 结束日期时间选择器 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-003 | 标注人、任务状态及查询 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-004 | 更多条件展开 / 收起 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-005 | 任务ID / 名称查询 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-006 | 驳回次数、改派下限及质检人筛选 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF06(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-007 | 无效日期 / 数字条件 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF07(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-013 | 任务数量标签设置 | reports/full-functional-2026-10-02/report-supplement-results.json#RS01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-014 | 数量标签本地偏好恢复与迁移 | reports/full-functional-2026-10-02/report-supplement-results.json#RS01(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-015 | 标注作业概览与作业明细 XLSX 导出 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF08(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-016 | 任务数量详情展开和次要指标显示 | reports/full-functional-2026-10-02/report-supplement-results.json#RS02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-017 | 任务明细固定顺序及上一页/下一页 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF09(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-018 | 任务行展开 / 收起时间线 | reports/full-functional-2026-10-02/report-supplement-results.json#RS02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-019 | 生成任务明细 CSV | reports/full-functional-2026-10-02/functional-100-results.json#F062(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-020 | 下载 CSV 与导出记录刷新 | reports/full-functional-2026-10-02/functional-100-results.json#F062(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-021 | 报告读取失败 | reports/full-functional-2026-10-02/functional-task-report-supplement.json#RF10(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-001 | 日期起止、标注人查询及刷新 | tests/annotation-job-report-browser.test.mjs:92<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B018(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B018(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-002 | 人员作业表及首次 / 返修口径 | tests/annotation-job-report-browser.test.mjs:108<br>reports/full-functional-2026-10-02/functional-statistics-supplement.json#ST02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-003 | 查看 / 隐藏仅有质检记录人员 | tests/annotation-job-report-browser.test.mjs:108 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-004 | 统计口径折叠说明 | tests/annotation-job-report-browser.test.mjs:108<br>reports/full-functional-2026-10-02/functional-statistics-supplement.json#ST03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-005 | 总作业 / 首次文案审核 / 文案一次通过率 / 首次图片审核图表 | tests/annotation-job-report-browser.test.mjs:92<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B018(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B018(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-006 | 有作业日 / 自然日 | tests/annotation-job-report-browser.test.mjs:92<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B018(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B018(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-007 | 显示 / 隐藏数值 | tests/annotation-job-report-browser.test.mjs:92<br>reports/full-functional-2026-10-02/functional-browser-retests.json#B018(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B018(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-008 | 人员图例选择、全选及反选 | tests/annotation-job-report-browser.test.mjs:92 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-009 | 图表工具提示、缩放与长时间范围 | tests/annotation-job-report-browser.test.mjs:92 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-ANNOT-010 | 无数据 / 无有效首检 / 加载失败 | reports/full-functional-2026-10-02/functional-browser-retests.json#B018(PASS)<br>reports/full-functional-2026-10-02/functional-browser-targeted-retests.json#B018(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-001 | 服务商列表读取、失败重新加载 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-002 | 搜索 Query 空值 / 500 字上限 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-003 | 服务商勾选 / 取消及已选数量 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-004 | API Key 输入显示 / 隐藏 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-005 | 搜索模型及服务专属选项输入 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-006 | DeepSeek 对照搜索 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-007 | 阿里 IQS / OpenSearch / 百炼对照搜索 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-008 | 小米 MiMo / 智谱 / 百度千帆搜索 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-009 | 讯飞星火 / 腾讯 WSA 搜索 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-010 | 豆包 Global / Custom 及 ICP 选项 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-011 | Kimi / MiniMax 搜索及地域 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-012 | 开始多家对照搜索与停止等待 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-013 | 搜索结果统计及摘要复制 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-014 | 来源链接与正文展示 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-015 | 读取 / 重读系统文案配置 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-016 | 生成服务选择、模型及本次生成 Key | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-017 | 内容分类、目标人群、配图 auto / 3 / 4 / 5 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-018 | 补充文案要求 2000 字及自动审核 / 自动修订开关 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-019 | 单家生成最终文案 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-020 | 为所有成功结果生成 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-021 | 文案生成中禁止新搜索及重复生成 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-022 | 重新生成文案 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-023 | 最终稿、原稿、修订输出与审核结果展开 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-024 | 复制最终文案及下载 TXT | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-025 | 任务失败 / 拒绝 / 超时及凭证脱敏 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-LAB-026 | 模型 / 服务不可用条件 | tests/search-lab-browser.test.mjs:53 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-001 | 后台登录正确 / 错误 / 空值及退出 | reports/full-functional-2026-10-02/preview/results.json#PV-01(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-10(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-002 | 单条创建 / 批量创建页签 | reports/full-functional-2026-10-02/preview/results.json#PV-02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-003 | 单条标题、正文、原图上传 | reports/full-functional-2026-10-02/preview/results.json#PV-02(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-11(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-004 | 单条缺图、过多、单图 / 总字节超限 | reports/full-functional-2026-10-02/preview/results.json#PV-02(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-11(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-005 | 生成单条预览链接 | reports/full-functional-2026-10-02/preview/results.json#PV-02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-006 | 成功复制链接 / 打开预览 | reports/full-functional-2026-10-02/preview/results.json#PV-02(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-007 | 批量添加一条 | reports/full-functional-2026-10-02/preview/results.json#PV-03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-008 | 批量移除条目 | reports/full-functional-2026-10-02/preview/results.json#PV-03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-009 | 批量各条文案及各自图片 | reports/full-functional-2026-10-02/preview/results.json#PV-03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-010 | 批量数量 / 总图 / 总字节与原子校验 | reports/full-functional-2026-10-02/preview/results.json#PV-03(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-11(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-011 | 生成多个预览及复制全部 / 打开第一个 | reports/full-functional-2026-10-02/preview/results.json#PV-03(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-012 | 预览记录刷新与搜索标题 / Query / publicId | reports/full-functional-2026-10-02/preview/results.json#PV-04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-013 | 全部 / 可访问 / 已撤销 / 未找到分类 | reports/full-functional-2026-10-02/preview/results.json#PV-04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-014 | 记录每页大小和上下页 | reports/full-functional-2026-10-02/preview/results.json#PV-04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-015 | 记录复制及打开预览 | reports/full-functional-2026-10-02/preview/results.json#PV-04(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-016 | 撤销预览确认与取消 | reports/full-functional-2026-10-02/preview/results.json#PV-08(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-017 | 接口密钥弹窗打开及已有列表 | reports/full-functional-2026-10-02/preview/results.json#PV-06(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-018 | 新密钥名称及创建 / 读取 / 撤销权限勾选 | reports/full-functional-2026-10-02/preview/results.json#PV-06(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-12(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-019 | 生成与复制新密钥 | reports/full-functional-2026-10-02/preview/results.json#PV-06(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-020 | 撤销接口密钥及确认取消 | reports/full-functional-2026-10-02/preview/results.json#PV-09(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-021 | API Key 不同 scope 请求 | reports/full-functional-2026-10-02/preview/results.json#PV-07(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-12(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-022 | 公开预览图文显示 | reports/full-functional-2026-10-02/preview/results.json#PV-05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-023 | 公开预览上一张 / 下一张与边界 | reports/full-functional-2026-10-02/preview/results.json#PV-05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-024 | 公开不可用：非法、缺失、已撤销 ID | reports/full-functional-2026-10-02/preview/results.json#PV-07(PASS)<br>reports/full-functional-2026-10-02/preview/results.json#PV-08(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-PREVIEW-025 | 公开页移动尺寸与多图布局 | reports/full-functional-2026-10-02/preview/results.json#PV-05(PASS) | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-001 | 任务历史与人工评分记录展开 | tests/copy-review-controls-browser.test.mjs:39 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-002 | 图集生成、修改、格式处理历史 | tests/history-knowledge-failure-browser.test.mjs:42 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-003 | 模型调用列表及阶段选择 | tests/model-call-trace-browser.test.mjs:88 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-004 | 模型请求完整 Prompt / 结构化字段 / 图片附件 | tests/model-call-trace-browser.test.mjs:88 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-005 | 模型响应正文 / JSON / 工具与错误展示 | tests/model-call-trace-browser.test.mjs:88 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-006 | 失败调用诊断 / 重试读取 / 请求截断与附件文件位置显示 | tests/model-call-trace-browser.test.mjs:136 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-TRACE-007 | 调研来源及小红书 Query 文章链接 | tests/model-call-trace-browser.test.mjs:88 | PARTIAL_BROWSER_PASS_EVIDENCE |
| F-REPORT-008 | 我的查询方案打开 / 关闭及选择方案 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-REPORT-009 | 方案另存为 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-REPORT-010 | 覆盖方案 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-REPORT-011 | 设为默认方案 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |
| F-REPORT-012 | 删除方案确认与取消 | 无实际浏览器动作关联 | NOT_APPLICABLE_CURRENT_UI |

## 当前页面边界

- 词包页面无重命名或废弃恢复入口；搜索节点页面仅展示信息与安全移除，未挂载新增/编辑。
- 个人统计日期按钮为今天、昨天、近7天和自定义；30天参数应通过自定义测试，不虚构额外按钮。
- 任务报表查询方案CRUD弹窗没有打开入口，列为未挂载而非已测；对应API测试不能替代UI。
- 屏幕取色浏览器回归使用EyeDropper假实现，证明UI分支，不代表设备真实桌面取色；第三方模型和发布须查看独立实测证据。
- 已存在source-only旧图文审核/旧文案QA入口退役，应以当前负责人图片初审和文案V2功能为准。

未覆盖行可在 browser-feature-action-audit.json 按 NO_BROWSER_ACTION_EVIDENCE 筛选；已有部分证据仍需对照 scope 逐分支核实，不能将整组参数一键标通过。
