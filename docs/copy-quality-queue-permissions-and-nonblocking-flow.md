# 文案质量队列：账号权限模型与非阻塞流程方案

- 状态：提案
- 日期：2026-09-14
- 范围：文案审核、比例抽检、质检、返工强制复检

## 1. 目标和核心决定

本方案采用“账号 + 独立权限 + 队列数据范围”，不再用 ADMIN、REVIEWER、USER 固定角色决定业务能力。

1. 新建账号默认获得 QUEUE_BROWSE 和 COPY_REVIEW，默认没有 COPY_QC。
2. 管理人员可以为指定账号开启或关闭质检权限，变更立即生效并保留审计记录。
3. “管理员”不再是角色，而是显式拥有管理类权限的账号；初始系统管理账号拥有全部权限。
4. 一个账号可以同时有审核和质检权限；非管理员账号不能质检自己最终审核通过的文案，管理员不受此限制。
5. 权限回答“能做什么”，队列成员关系回答“可以在哪个队列做”。
6. 每个质量队列独立设置来源、成员、质检比例、盲检和领取上限。
7. 生产状态与质量状态分开，文案质检和生图可以并行，最终交付执行质量门禁。

有效权限计算：

账号启用 AND 权限启用 AND（账号是队列有效成员 OR 拥有全局队列管理权限）

## 2. 权限目录

| 权限代码 | 能看到 | 能做 | 不能做 |
| --- | --- | --- | --- |
| QUEUE_BROWSE | 已加入队列、队列计数、只读任务状态 | 搜索、筛选、查看允许公开的内容 | 领取、审核、质检、改设置 |
| COPY_REVIEW | 所属队列审核页、待审核和待返修任务 | 领取、评分、修改、保存、通过、废弃、提交返工稿 | 质检通过或打回 |
| COPY_QC | 所属队列质检页、抽中项和强制复检项 | 领取质检、单条通过、单条打回 | 修改文案、提交初审、质检自己的文案 |
| QC_WINDOW_RETURN | 当前质检窗口及影响预览 | 整组打回、显式放行其他成员 | 暂停队列、修改比例 |
| QUEUE_MANAGE | 全部质量队列、来源、成员和统计 | 创建、编辑、暂停队列，设置比例，绑定词包，分配成员，关闭不足组 | 管理账号和系统设置 |
| ACCOUNT_MANAGE | 账号、权限开关、权限变更记录 | 创建、停用账号，开启或关闭权限 | 自动获得文案内容访问权 |
| PRODUCTION_MANAGE | Query词包、全部作业、派单和交付池 | 导入词包、创建任务、调整优先级、交付操作 | 修改系统设置 |
| SYSTEM_MANAGE | 提示词、知识库、模型、执行机和生产配置 | 修改系统配置 | 自动获得审核或质检能力 |

管理权限不隐式包含业务权限。需要审核或质检时仍须显式授予 COPY_REVIEW 或 COPY_QC。

## 3. 不同权限账号的可见范围

### 3.1 默认审核账号

默认拥有 QUEUE_BROWSE + COPY_REVIEW。

可以看到和操作：

- 自己加入的队列，以及待标注、审核中、待质检、质检中、待返修数量；
- 所属队列的审核页签；
- 待审核文案、Query、机器稿、评分标准和修改区域；
- 自己领取中的任务和自己的审核历史；
- 质检打回给自己的原因；
- 领取、评分、修改、保存、通过、废弃和提交强制复检。

不能看到和操作：

- 质检页签和质检提交按钮；
- 未加入的队列；
- 质检人员身份、内部正确率统计；
- 队列比例、人员和系统配置。

### 3.2 增加质检权限的账号

管理员开启 COPY_QC 后，账号在原权限基础上增加：

- 所属队列的质检页签；
- 待质检数量和自己领取中的质检项；
- 抽中的普通质检项和100%强制复检项；
- 单条质检通过和单条质检打回。

非管理员账号即使同时拥有审核和质检权限，仍须满足：

质检账号ID != 最终审核账号ID

自己审核的文案不会出现在自己的质检列表；猜测任务ID访问详情或直接调用接口也必须被拒绝。系统管理员作为人工例外可处理自己最终审核的文案，并保留完整审计记录。

盲检开启时，质检响应隐藏正式任务ID、Query、词包名称、审核人、原评分、原审核原因和未抽中任务。

### 3.3 队列管理账号

拥有 QUEUE_MANAGE 后可以：

- 创建多个质量队列；
- 绑定一个或多个Query词包；
- 设置0%至100%的质检比例；
- 设置盲检、领取上限、超时和不足组规则；
- 增加或移除队列成员；
- 暂停新领取、释放超时领取；
- 手动关闭不足抽样组；
- 查看队列积压、通过率、打回率和最长等待；
- 对系统性问题暂停整个队列。

QUEUE_MANAGE 不允许修改人员账号权限，除非另外拥有 ACCOUNT_MANAGE。

## 4. 完整ER图

\`\`\`mermaid
erDiagram
    ACCOUNT {
        bigint id PK
        varchar username UK
        varchar display_name
        varchar status
        int credential_version
        int permission_version
        timestamptz created_at
        timestamptz updated_at
    }

    PERMISSION {
        varchar code PK
        varchar name
        varchar category
        varchar risk_level
        varchar description
    }

    ACCOUNT_PERMISSION {
        bigint id PK
        bigint account_id FK
        varchar permission_code FK
        varchar scope_type
        bigint queue_id FK
        boolean enabled
        bigint granted_by_account_id FK
        timestamptz granted_at
        bigint revoked_by_account_id FK
        timestamptz revoked_at
        bigint version
    }

    PERMISSION_EVENT {
        bigint id PK
        bigint account_permission_id FK
        bigint target_account_id FK
        bigint operator_account_id FK
        varchar action
        jsonb before_value
        jsonb after_value
        timestamptz created_at
    }

    QUALITY_QUEUE {
        bigint id PK
        uuid public_id UK
        varchar name
        varchar description
        varchar status
        bigint current_policy_id FK
        bigint created_by_account_id FK
        bigint version
        timestamptz created_at
        timestamptz updated_at
    }

    QUEUE_MEMBERSHIP {
        bigint queue_id PK,FK
        bigint account_id PK,FK
        varchar status
        int review_claim_limit
        int qc_claim_limit
        bigint assigned_by_account_id FK
        timestamptz joined_at
        timestamptz removed_at
    }

    QUEUE_POLICY {
        bigint id PK
        bigint queue_id FK
        bigint policy_version
        int sampling_rate_bps
        int group_population_target
        int sample_target
        varchar remainder_policy
        boolean blind_qc_enabled
        boolean window_return_enabled
        int max_group_wait_minutes
        bigint created_by_account_id FK
        timestamptz effective_at
    }

    QUERY_PACKAGE {
        bigint id PK
        varchar name
        varchar status
        bigint version
    }

    QUEUE_QUERY_PACKAGE {
        bigint queue_id PK,FK
        bigint query_package_id PK,FK
        int priority
        boolean enabled
    }

    PRODUCTION_BATCH {
        bigint id PK
        bigint query_package_id FK
        varchar query_package_name
        varchar status
    }

    TASK {
        bigint id PK
        bigint production_batch_id FK
        varchar query
        varchar state
        bigint current_copy_revision_id FK
        boolean mandatory_copy_qc
        timestamptz created_at
        timestamptz updated_at
    }

    QUEUE_ITEM {
        bigint id PK
        bigint queue_id FK
        bigint task_id FK
        varchar review_status
        varchar sampling_status
        varchar qc_status
        varchar delivery_gate_status
        int priority
        bigint version
        timestamptz entered_at
        timestamptz updated_at
    }

    COPY_REVISION {
        bigint id PK
        bigint task_id FK
        bigint parent_revision_id FK
        int revision
        jsonb content
        char content_sha256
        varchar revision_origin
        timestamptz created_at
    }

    REVIEW_ATTEMPT {
        bigint id PK
        bigint queue_item_id FK
        bigint copy_revision_id FK
        bigint reviewer_account_id FK
        varchar decision
        int score_x10
        text_array reason_codes
        text note
        char content_sha256
        uuid request_id
        timestamptz submitted_at
    }

    SAMPLING_WINDOW {
        bigint id PK
        uuid public_id UK
        bigint queue_id FK
        bigint queue_policy_id FK
        varchar status
        int population_count
        int sample_count
        int quota_remainder
        varchar algorithm_version
        varchar seed
        char snapshot_sha256
        timestamptz opened_at
        timestamptz frozen_at
        timestamptz resolved_at
    }

    SAMPLING_MEMBER {
        bigint id PK
        bigint sampling_window_id FK
        bigint queue_item_id FK
        bigint review_attempt_id FK
        boolean selected
        boolean mandatory_recheck
        varchar status
        char rank_hash
        char content_sha256
    }

    QC_ATTEMPT {
        bigint id PK
        bigint sampling_member_id FK
        bigint qc_account_id FK
        varchar decision
        text_array reason_codes
        text note
        uuid request_id
        timestamptz submitted_at
    }

    WORK_CLAIM {
        bigint id PK
        bigint queue_item_id FK
        bigint account_id FK
        varchar stage
        varchar status
        bigint item_version
        timestamptz claimed_at
        timestamptz expires_at
        timestamptz released_at
    }

    QUEUE_EVENT {
        bigint id PK
        bigint queue_id FK
        bigint queue_item_id FK
        bigint actor_account_id FK
        varchar action
        jsonb details
        timestamptz created_at
    }

    ACCOUNT ||--o{ ACCOUNT_PERMISSION : has
    PERMISSION ||--o{ ACCOUNT_PERMISSION : grants
    QUALITY_QUEUE o|--o{ ACCOUNT_PERMISSION : scopes
    ACCOUNT_PERMISSION ||--o{ PERMISSION_EVENT : audits
    ACCOUNT ||--o{ PERMISSION_EVENT : operates

    ACCOUNT ||--o{ QUEUE_MEMBERSHIP : joins
    QUALITY_QUEUE ||--o{ QUEUE_MEMBERSHIP : contains
    QUALITY_QUEUE ||--o{ QUEUE_POLICY : versions
    QUALITY_QUEUE ||--o{ QUEUE_QUERY_PACKAGE : binds
    QUERY_PACKAGE ||--o{ QUEUE_QUERY_PACKAGE : supplies

    QUERY_PACKAGE ||--o{ PRODUCTION_BATCH : creates
    PRODUCTION_BATCH ||--o{ TASK : contains
    QUALITY_QUEUE ||--o{ QUEUE_ITEM : contains
    TASK ||--o{ QUEUE_ITEM : enters
    TASK ||--o{ COPY_REVISION : owns

    QUEUE_ITEM ||--o{ REVIEW_ATTEMPT : reviews
    COPY_REVISION ||--o{ REVIEW_ATTEMPT : targets
    ACCOUNT ||--o{ REVIEW_ATTEMPT : performs

    QUALITY_QUEUE ||--o{ SAMPLING_WINDOW : rolls
    QUEUE_POLICY ||--o{ SAMPLING_WINDOW : freezes
    SAMPLING_WINDOW ||--o{ SAMPLING_MEMBER : contains
    QUEUE_ITEM ||--o{ SAMPLING_MEMBER : participates
    REVIEW_ATTEMPT ||--o| SAMPLING_MEMBER : supplies

    SAMPLING_MEMBER ||--o{ QC_ATTEMPT : receives
    ACCOUNT ||--o{ QC_ATTEMPT : performs
    QUEUE_ITEM ||--o{ WORK_CLAIM : claims
    ACCOUNT ||--o{ WORK_CLAIM : owns
    QUALITY_QUEUE ||--o{ QUEUE_EVENT : records
    QUEUE_ITEM o|--o{ QUEUE_EVENT : relates
    ACCOUNT ||--o{ QUEUE_EVENT : acts
\`\`\`

关键约束：

- 同一任务同一时间只能存在一个有效队列项。
- 同一队列项同一阶段只能有一个有效领取。
- 权限、审核和质检责任主体使用稳定账号ID，不使用可复用用户名。
- 队列策略只新增版本，不覆盖已经形成的抽样窗口。

## 5. 队列质检比例

| 设置 | 完整抽样窗口 | 抽中 |
| --- | ---: | ---: |
| 100% | 1条 | 1条 |
| 50% | 2条 | 1条 |
| 20% | 5条 | 1条 |
| 10% | 10条 | 1条 |
| 30% | 10条 | 3条 |
| 0% | 不形成普通抽检窗口 | 0条 |

普通抽检按队列比例执行；质检打回或图文终审打回的返工稿始终100%强制复检。

比例变更会产生新的 QUEUE_POLICY 版本。旧窗口继续使用旧比例，新窗口使用新比例。

20%队列不足5条时：

- 队列继续运行：任务进入待成组，后续审核结果凑满5条；
- 达到最长等待时间：按向上取整结算，保证正比例的小批次至少质检1条；
- 管理员暂停或归档队列：必须先预览并结算不足组。

## 6. 非阻塞流程方案

### 6.1 质量状态与生产状态解耦

TASK.state 只描述文案生成、生图和交付生产进度。

QUEUE_ITEM 独立保存：

- review_status：待审核、审核中、审核完成、待返工；
- sampling_status：待成组、已抽中、未抽中；
- qc_status：无需质检、待质检、质检中、通过、打回；
- delivery_gate_status：无需门禁、等待质检、允许交付、禁止交付。

一条任务可以同时处于：

- TASK.state = IMAGE_RUNNING；
- qc_status = PENDING；
- delivery_gate_status = HELD。

因此文案质检不会阻塞生图，但必要质检未完成时不能进入最终交付池。

### 6.2 流程图

\`\`\`mermaid
flowchart LR
    A[文案生成完成] --> B[待审核]
    B --> C[审核员领取]
    C --> D[审核通过]
    D --> E[立即进入待生图]
    D --> F{按队列比例抽样}
    F -->|未抽中| G[无需普通质检]
    F -->|抽中| H[待质检]
    E --> I[生图和图片审核]
    H --> J[质检员领取]
    J -->|通过| K[解除交付门禁]
    J -->|打回| L[文案返工]
    G --> K
    I --> M{图片完成且门禁解除}
    K --> M
    M -->|是| N[进入交付池]
    M -->|否| O[等待对应环节]
    L --> P[审核员修改]
    P --> Q[100%强制复检]
    Q -->|通过| R[重新生图]
    Q -->|打回| L
    R --> K
\`\`\`

### 6.3 100%全检

- 每条审核通过后立即产生质检项；
- 每条任务同时进入待生图；
- 生图与文案质检并行；
- 质检通过且图片审核完成后才能进入交付池；
- 质检打回后，当前文案及基于该文案生成的图片版本失去交付资格。

100%会增加交付等待，但不会让文案生成、其他审核或生图执行机停止。

### 6.4 20%抽检

- 每5条形成一个逻辑抽样窗口，固定抽1条；
- 5条在审核完成后都可以继续生图；
- 抽中的1条增加交付质检门禁；
- 未抽中的4条在窗口冻结后立即标记为无需质检；
- 单条质检失败默认不阻塞其他4条；
- 只有拥有 QC_WINDOW_RETURN 的账号显式升级为整组问题时，才影响整个窗口。

### 6.5 不足组处理

审核不等待抽样窗口凑满：

1. 审核完成后任务立即进入生图。
2. 队列项暂时标记为 SAMPLING_UNDECIDED。
3. 窗口凑满或达到最长等待时间后冻结。
4. 抽中项进入质检并增加交付门禁。
5. 未抽中项解除抽样待定状态。

建议最长等待默认10分钟。窗口等待期间可以生图，只暂缓最终交付，因此不会占住审核和生图队列。

### 6.6 质检打回

质检打回在一个事务中完成：

1. 质检项标记为 RETURNED。
2. 当前文案版本标记为质量失效。
3. 队列项进入 REWORK_PENDING。
4. 未开始的生图任务取消领取。
5. 正在生成的图片允许执行结束，但结果标记为过期。
6. 已生成图片撤销交付资格并作为历史版本保留。
7. 创建返工文案版本。
8. 返工稿审核通过后进入100%强制复检。

已知存在问题的返工稿使用硬门禁：强制复检通过前不重新生图。该门禁只阻塞问题任务，不阻塞整个队列。

## 7. 权限开启和关闭

### 开启质检权限

1. 新建或重新启用 COPY_QC 权限记录。
2. 保存授权人、授权范围和时间。
3. 账号 permission_version 加一。
4. 页面刷新后出现质检页签。
5. 账号只能处理所属队列且不是自己审核的质检项。

### 关闭质检权限

1. 不删除记录，将 enabled 设置为 false。
2. 保存撤销人、时间和权限事件。
3. 账号 permission_version 加一。
4. 立即释放该账号未提交的质检领取。
5. 已领取项恢复为待质检。
6. 后续质检列表、详情和提交请求立即拒绝。
7. 审核权限不受影响。
8. 历史质检结论和责任人保留。

系统不得关闭最后一个有效的 ACCOUNT_MANAGE 权限，避免失去权限管理入口。

## 8. 队列首页计数

每个队列在同一个响应中返回：

- waitingCopyCount：等待机器文案；
- pendingReviewCount：待标注，包含初审和返工；
- reviewClaimedCount：审核中；
- samplingUndecidedCount：待成组；
- pendingQcCount：待质检，包含普通抽检和强制复检；
- qcClaimedCount：质检中；
- reworkCount：质检打回待返修；
- deliveryHeldCount：生产已完成但等待质量门禁；
- completedTodayCount：今日完成；
- oldestPendingSeconds：最长等待时间。

第一版使用数据库聚合查询读取真实数量，不维护容易漂移的缓存计数。操作后立即刷新，页面每10秒后台同步一次。

## 9. 领取和并发

- 审核与质检使用数据库行锁和 SKIP LOCKED 领取下一条。
- 同一队列项同一阶段最多一个有效领取。
- 领取保存账号ID、队列项版本和过期时间。
- 提交时校验领取账号、权限版本、任务版本和文案指纹。
- 页面中断后领取在超时后自动释放。
- 权限关闭或账号停用时，未提交领取立即释放。
- 已提交的审核和质检历史永久保留。

## 10. 迁移当前系统

### 权限回填

- 现有 USER：授予 QUEUE_BROWSE + COPY_REVIEW。
- 现有 REVIEWER：临时授予 QUEUE_BROWSE + COPY_REVIEW + COPY_QC，避免升级中断；管理员随后可以关闭。
- 现有 ADMIN：显式授予全部管理和业务权限。
- 新账号：默认 QUEUE_BROWSE + COPY_REVIEW。

### 在途任务

- 已冻结的旧抽检批次继续按旧逻辑完成，不重新抽样。
- 尚未冻结的生产批次绑定默认质量队列。
- 新审核结果进入新队列和并行质检流程。
- 旧 copy_sampling 系列表保留历史查询。
- 新流程写入队列、窗口和新质检记录。

### 移除固定角色

第一阶段保留 app_users.role 作为兼容字段，但不再用于新接口授权。完成所有页面、接口和自动派单改造后，再通过独立迁移删除角色字段。

需要替换的现有判断包括：

- role 等于 ADMIN；
- role 等于 REVIEWER；
- 只允许 ADMIN、REVIEWER 的路由；
- 自动派单池只允许 USER。

统一替换为权限检查、队列成员检查和非管理员禁止自检检查。

## 11. 验收标准

1. 新账号自动拥有浏览和审核权限，没有质检权限。
2. 管理人员可以独立开启、关闭质检权限。
3. 关闭权限后旧会话不能继续读取或提交质检。
4. 权限关闭不删除历史审核和质检数据。
5. 同一非管理员账号可同时审核和质检，但不能质检自己的审核结果；管理员可执行该操作。
6. 有权限但未加入队列时不能查看该队列。
7. 可以同时运行多个不同质检比例的队列。
8. 100%队列每条产生质检项。
9. 20%完整窗口每5条准确抽1条。
10. 不足组达到超时后按向上取整结算。
11. 审核完成后不等待生产批次闭合即可进入生图。
12. 文案质检和生图可以并行。
13. 必须质检的任务在通过前不能进入最终交付池。
14. 质检打回会撤销当前文案和相关图片的交付资格。
15. 返工稿必须通过100%强制复检。
16. 普通单条质检失败不阻塞同组未抽中的任务。
17. 两名人员不能同时领取同一条审核或质检任务。
18. 队列首页同时准确显示待标注和待质检数量。
19. 权限、领取、抽样、通过、打回和放行都有审计事件。
20. 自动化测试只用隔离数据库或测试替身，不调用真实模型额度。
