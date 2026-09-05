import React, { createContext, useCallback, useContext, useState } from 'react';

const LANGUAGE_STORAGE_KEY = 'codex_pool_language';

const DICTIONARY = {
  en: {
    // Top Bar & Navigation
    'userGuide': 'User Guide',
    'languageLabel': 'Switch language',
    'adminAnalytics': 'Admin analytics',
    'backToDashboard': 'Back to dashboard',
    'signOut': 'Sign out',
    'done': 'Done',
    'cancel': 'Cancel',
    'close': 'Close',
    'save': 'Save',
    'create': 'Create',
    'edit': 'Edit',
    'refresh': 'Refresh',
    'delete': 'Delete',
    'confirm': 'Confirm',
    'retry': 'Try again',

    // Hero / Auth
    'quotaSharing': 'Quota sharing',
    'heroSubtitle': 'Community capacity for high-demand windows. Pool tokens, back priority queues, and coordinate shared access safely.',
    'loginWithSmart': 'Login with Smart',
    'loginWithSmartSub': 'Detects session or redirects to Smart portal',
    'linkCodex': 'Link Codex',
    'linkCodexSub': 'OAuth device-auth with OpenAI',
    'authenticatingSmart': 'Authenticating with Smart session...',
    'smartAuthFailed': 'Smart session login failed',

    // Section switch
    'forProviders': 'For Providers',
    'forConsumers': 'For Consumers',

    // Tabs
    'tabCommunityOffers': 'Community offers',
    'tabMyOffers': 'My published offers',
    'tabQuotaRequests': 'Friends seeking quota',
    'tabSentRequests': 'Sent requests',
    'tabApprovals': 'Incoming requests (Approvals)',
    'tabMyAccess': 'My access (Granted sessions)',
    'tabSharedByMe': 'Active shares granted',

    // Actions & Search
    'publishOffer': 'Publish offer',
    'askFriends': 'Ask friends',
    'searchByEmail': 'Search by email...',

    // Provider Card / Overview
    'noShareProviderLinked': 'No share provider linked',
    'noShareProviderDesc': 'Link Codex, Claude, or an AIS project to start sharing quota.',
    'yourShareProviders': 'Your share providers',
    'shareProvidersDesc': 'Codex & Claude quota refresh automatically; AIS is managed externally.',
    'linkClaude': 'Link Claude',
    'linkAis': 'Link AIS',
    'credentials': 'Credentials',
    'refreshQuota': 'Refresh quota',
    'reconnect': 'Reconnect',
    'updateToken': 'Update token',
    'useAuthJson': 'Use auth.json',
    'pauseSharing': 'Pause sharing',
    'resumeSharing': 'Resume sharing',
    'revokeAll': 'Revoke all',
    'revokeAllConfirmTitle': 'Revoke all sharing sessions?',
    'revokeAllConfirmDesc': 'This will immediately revoke all active share sessions backed by this provider. Consumers will lose access until re-approved.',
    'revokeAllSessions': 'Revoke all sessions',
    'unknownQuota': 'Unknown Quota',
    'unknownQuotaCardExplanation': 'Codex Share cannot retrieve your real remaining quota for this account. Check your actual balance in {app} before sharing. Note: The quota number set here is just a target limit; actual API usage is strictly restricted by your provider\'s real available quota.',
    'unknownQuotaSourceExplanation': 'Provider quota is managed in {app}. The quota number set here is just a target limit and is strictly restricted by your provider\'s real available quota.',
    'unknownQuotaDialogExplanation': 'Provider remaining quota cannot be checked automatically. Check your real balance in {app} before allocating. The quota number set here is just a target limit; downstream requests are always restricted by your provider\'s actual quota.',
    'checkBalanceIn': 'Check remaining balance in {app}.',
    'committedUnknownQuota': '${amount} committed · provider quota unknown',
    'underfundedNotice': 'This provider is underfunded by ${amount}. Some active sessions or offers may run out of capacity unless refreshed.',
    'externalQuotaNotice': 'External quota notice',

    // Personal Keys Card
    'myKeys': 'My keys',
    'myKeysSubtitle': 'Personal access keys for your CLI and editors.',
    'createKey': 'Create key',
    'createKeyPrompt': 'Create a named key for each device or client you use.',
    'reveal': 'Reveal',
    'rotate': 'Rotate',
    'revoke': 'Revoke',
    'revokeKeyConfirmTitle': 'Revoke personal key?',
    'revokeKeyConfirmDesc': 'Any CLI or client using this key will immediately be disconnected.',

    // Tables headers & columns
    'provider': 'Provider',
    'consumer': 'Consumer',
    'offered': 'Offered',
    'source': 'Source',
    'status': 'Status',
    'expires': 'Expires',
    'actions': 'Actions',
    'requester': 'Requester',
    'requested': 'Requested',
    'activity': 'Activity',
    'sessions': 'Sessions',
    'noExpiry': 'No expiry',
    'unavailable': 'Unavailable',
    'requestedBtn': 'Requested',
    'requestQuotaBtn': 'Request quota',
    'rejectBtn': 'Reject',
    'approveBtn': 'Approve',
    'cancelBtn': 'Cancel',
    'publishMatchingOffer': 'Publish matching offer',
    'active': 'Active',
    'paused': 'Paused',
    'closed': 'Closed',

    // Table Empty States
    'emptyCommunityOffersTitle': 'No community offers available',
    'emptyCommunityOffersDesc': 'There are no active capacity offers published right now. You can post a quota request to let providers know what you need.',
    'emptyMyOffersTitle': 'No published offers',
    'emptyMyOffersDesc': 'You have not published any capacity offers yet. Share capacity from your linked providers to help teammates.',
    'emptyQuotaRequestsTitle': 'No open requests',
    'emptyQuotaRequestsDesc': 'No teammates are currently looking for capacity. Check back later or publish an offer for the team.',
    'emptySentRequestsTitle': 'No sent requests',
    'emptySentRequestsDesc': 'You have not requested capacity from any offers or providers yet.',
    'emptyApprovalsTitle': 'No pending approvals',
    'emptyApprovalsDesc': 'You have no incoming quota requests waiting for approval.',
    'emptyMyAccessTitle': 'No granted access sessions',
    'emptyMyAccessDesc': 'You do not have any active sharing sessions yet. Request quota from an offer to get started.',
    'emptySharedByMeTitle': 'No active shares granted',
    'emptySharedByMeDesc': 'You have not granted access to any consumers yet.',
    'noEmailMatch': 'No provider or consumer email matches "{query}".',

    // Dialogs
    'publishOfferDialogTitle': 'Publish capacity offer',
    'publishOfferDialogSub': 'Offer quota from one of your linked providers to the community.',
    'editOfferDialogTitle': 'Edit capacity offer',
    'editOfferDialogSub': 'Update offered amount or expiration date.',
    'shareSource': 'Share source',
    'offeredQuotaDollars': 'Offered quota ($)',
    'availableToOffer': 'Available to offer: ${amount}',
    'expirationDate': 'Expiration date',
    'optional': 'Optional',
    'publishOfferBtn': 'Publish offer',
    'updateOfferBtn': 'Update offer',

    'askFriendsDialogTitle': 'Ask friends for quota',
    'askFriendsDialogSub': 'Post a request visible to all capacity providers in the workspace.',
    'requestedQuotaDollars': 'Requested quota ($)',
    'neededByDate': 'Needed until date',
    'postRequestBtn': 'Post request',

    'approveRequestDialogTitle': 'Approve quota request',
    'approvedQuotaDollars': 'Approved quota ($)',
    'approveRequestBtn': 'Approve request',

    'addSessionQuotaDialogTitle': 'Add session quota',
    'resizeSessionDialogTitle': 'Resize share session',
    'additionalQuotaDollars': 'Additional quota ($)',
    'grantedQuotaDollars': 'Granted quota ($)',
    'addQuotaBtn': 'Add quota',
    'saveChangesBtn': 'Save changes',

    'createKeyDialogTitle': 'Create personal key',
    'createKeyDialogSub': 'Generate a new personal key for your CLI or editor configuration.',
    'keyName': 'Key name',
    'keyNamePlaceholder': 'e.g., MacBook Pro, VS Code Workstation',
    'createKeyBtn': 'Create key',

    'keySecretDialogTitle': 'Personal access key',
    'keySecretDialogSub': 'Copy this key now. For your security, the full secret will not be displayed again.',
    'sessionKeyDialogTitle': 'Share session key',
    'sessionKeyDialogSub': 'Use this key in your client or proxy configuration to consume shared capacity.',
    'copyKey': 'Copy key',

    'linkCodexDialogTitle': 'Link OpenAI Codex',
    'linkCodexDialogSub': 'Authorize device authentication with OpenAI.',
    'codexStep1Title': '1. Open verification page',
    'codexStep1Desc': 'Confirm sign-in using your OpenAI account in the browser.',
    'codexStep2Title': '2. Enter one-time user code',
    'codexStep2Desc': 'Enter this authorization code on the verification page:',
    'openVerificationPage': 'Open verification page',
    'copyCode': 'Copy code',
    'generatingDeviceCode': 'Generating device authorization code...',
    'cancelSignIn': 'Cancel sign-in',

    'linkClaudeDialogTitle': 'Link Claude Account',
    'updateClaudeDialogTitle': 'Update Claude Token',
    'linkClaudeDialogSub': 'Connect your Claude Code Enterprise account using a setup token.',
    'claudeStep1Title': '1. Run command in your terminal',
    'claudeStep1Desc': 'Generate a secure setup token from Claude Code CLI:',
    'claudeStep2Title': '2. Paste your setup-token below',
    'claudeStep2Desc': 'Paste the token generated by the CLI (starts with sk-ant-oat01-):',
    'saveClaudeAccount': 'Save Claude Account',

    'linkAisDialogTitle': 'Link AIS Project',
    'editAisDialogTitle': 'Edit AIS Project',
    'linkAisDialogSub': 'Connect your AIS / Compass LLM project credentials.',
    'aisProjectId': 'AIS Project ID',
    'aisProjectKey': 'AIS Project Key',
    'aisProjectKeyPlaceholder': 'Enter secret key',
    'aisProjectKeyLeaveEmpty': 'Leave empty to keep existing key',
    'howToGetAis': 'How to get AIS project credentials?',
    'saveAisProject': 'Save AIS Project',

    'aisGuideStep1Title': '1. Open Compass',
    'aisGuideStep1Desc': 'Log in to compass.llm.shopee.io in your browser and visit Integration settings.',
    'aisGuideStep2Title': '2. Generate or retrieve the project key',
    'aisGuideStep2Desc': 'Open your browser DevTools console, paste this script, and run it.',
    'aisGuideStep3Title': '3. Enter the returned values',
    'aisGuideStep3Desc': 'Copy the displayed project_id and api_key into the fields.',

    'revealCredentialsDialogTitle': 'Provider Credentials Export',
    'revealCredentialsDialogSub': 'Raw credentials for your linked upstreams. Keep these private.',

    // Admin Page
    'adminSubtitle': 'A privacy-safe view of sharing health, adoption, and settled usage.',
    'adminMembers': 'Members',
    'adminLinkedProviders': 'Linked providers',
    'adminActiveOffers': 'Active offers',
    'adminActiveSessions': 'Active sessions',
    'adminPendingApprovals': 'Pending approvals',
    'adminOpenRequests': 'Open quota requests',
    'adminUsage': 'Usage',
    'adminSettledUsage': 'Settled usage',
    'adminToday': 'Today',
    'adminRequests': 'Requests',
    'adminSuccessRate': 'Success rate',
    'adminRequestFunnel': 'Request funnel',
    'adminTotalRequests': 'Total requests',
    'adminApproved': 'Approved',
    'adminRejected': 'Rejected',
    'adminApprovalRate': 'Approval rate',
    'adminProviderHealth': 'Provider health',
    'adminSharingActive': 'Sharing active',
    'adminSharingPaused': 'Sharing paused',
    'adminUnavailableProviders': 'Unavailable providers',
    'adminTopProviders': 'Top providers by settled usage',
    'adminTopConsumers': 'Top consumers by settled usage',
    'adminRecentActivity': 'Recent sharing activity',
    'adminLoadMore': 'Load more events'
  },
  zh: {
    // Top Bar & Navigation
    'userGuide': '使用指南',
    'languageLabel': '切换语言',
    'adminAnalytics': '管理分析',
    'backToDashboard': '返回控制面板',
    'signOut': '退出登录',
    'done': '完成',
    'cancel': '取消',
    'close': '关闭',
    'save': '保存',
    'create': '创建',
    'edit': '编辑',
    'refresh': '刷新',
    'delete': '删除',
    'confirm': '确认',
    'retry': '重试',

    // Hero / Auth
    'quotaSharing': '额度共享',
    'heroSubtitle': '面向高峰时段的社区共享算力。安全汇聚 Token，支持优先排队与协同访问。',
    'loginWithSmart': '使用 Smart 登录',
    'loginWithSmartSub': '自动检测本地会话或跳转至 Smart 统一认证中心',
    'linkCodex': '绑定 Codex',
    'linkCodexSub': '通过 OpenAI 设备授权登录',
    'authenticatingSmart': '正在验证 Smart 会话...',
    'smartAuthFailed': 'Smart 会话登录失败',

    // Section switch
    'forProviders': '提供方专区',
    'forConsumers': '使用方专区',

    // Tabs
    'tabCommunityOffers': '社区共享额度',
    'tabMyOffers': '我发布的共享',
    'tabQuotaRequests': '求额度广场',
    'tabSentRequests': '我的申请记录',
    'tabApprovals': '待我审批的申请',
    'tabMyAccess': '我的可用额度',
    'tabSharedByMe': '我已授权的共享',

    // Actions & Search
    'publishOffer': '发布共享额度',
    'askFriends': '向好友求额度',
    'searchByEmail': '按邮箱搜索...',

    // Provider Card / Overview
    'noShareProviderLinked': '尚未绑定任何算力提供方',
    'noShareProviderDesc': '绑定 Codex、Claude 或 AIS 项目即可开始共享额度。',
    'yourShareProviders': '已绑定的算力提供方',
    'shareProvidersDesc': 'Codex 与 Claude 额度自动刷新；AIS 额度在外部系统管理。',
    'linkClaude': '绑定 Claude',
    'linkAis': '绑定 AIS',
    'credentials': '凭证导出',
    'refreshQuota': '刷新额度',
    'reconnect': '重新连接',
    'updateToken': '更新 Token',
    'useAuthJson': '使用 auth.json',
    'pauseSharing': '暂停共享',
    'resumeSharing': '恢复共享',
    'revokeAll': '撤回全部共享',
    'revokeAllConfirmTitle': '确认撤回全部共享会话？',
    'revokeAllConfirmDesc': '此操作将立即注销该提供方名下的所有有效会话，使用方将立刻中断访问，需重新申请审批。',
    'revokeAllSessions': '确认撤回所有会话',
    'unknownQuota': '未知额度',
    'unknownQuotaCardExplanation': 'Codex Share 无法直接查询此账户的真实剩余额度。请在 {app} 中查看您的实际可用余额并据此分配。注意：此处设置的额度数值仅作为上限限制，实际 API 调用完全受限于您在提供方的真实可用额度。',
    'unknownQuotaSourceExplanation': '该提供方的额度在 {app} 中管理。此处设置的共享数值仅作为上限限制，实际调用严格受限于提供方的真实可用额度。',
    'unknownQuotaDialogExplanation': '系统无法直接获取提供方的剩余额度。请在分配前先在 {app} 中确认真实余额。此处填写的共享数值仅为额度上限，下游请求始终受限于提供方的真实可用额度。',
    'checkBalanceIn': '请在 {app} 中查看实际可用余额。',
    'committedUnknownQuota': '已承诺 ${amount} · 提供方额度未知',
    'underfundedNotice': '该提供方尚欠缺 ${amount} 额度。部分有效会话或共享额度可能在额度刷新前不足。',
    'externalQuotaNotice': '外部额度说明',

    // Personal Keys Card
    'myKeys': '我的密钥',
    'myKeysSubtitle': '用于命令行 CLI 及编辑器接入的个人密钥。',
    'createKey': '创建密钥',
    'createKeyPrompt': '为每台工作电脑或使用的客户端分别创建专属密钥。',
    'reveal': '查看密钥',
    'rotate': '轮换密钥',
    'revoke': '注销',
    'revokeKeyConfirmTitle': '确认注销此个人密钥？',
    'revokeKeyConfirmDesc': '使用此密钥的所有 CLI 或客户端将立即断开连接。',

    // Tables headers & columns
    'provider': '提供方',
    'consumer': '使用方',
    'offered': '提供额度',
    'source': '渠道',
    'status': '状态',
    'expires': '过期时间',
    'actions': '操作',
    'requester': '申请人',
    'requested': '申请额度',
    'activity': '调用活跃度',
    'sessions': '会话数',
    'noExpiry': '永久有效',
    'unavailable': '不可用',
    'requestedBtn': '已申请',
    'requestQuotaBtn': '申请额度',
    'rejectBtn': '拒绝',
    'approveBtn': '同意',
    'cancelBtn': '取消',
    'publishMatchingOffer': '发布匹配的共享',
    'active': '生效中',
    'paused': '已暂停',
    'closed': '已结束',

    // Table Empty States
    'emptyCommunityOffersTitle': '暂无可用的社区共享',
    'emptyCommunityOffersDesc': '当前还没有人发布共享额度。您可以发布求额度申请，让有闲置额度的朋友看到。',
    'emptyMyOffersTitle': '尚未发布任何共享',
    'emptyMyOffersDesc': '您还没有发布过额度共享。快从已绑定的提供方中划出一部分额度分享给同事吧。',
    'emptyQuotaRequestsTitle': '暂无求额度申请',
    'emptyQuotaRequestsDesc': '目前没有同事正在寻找算力额度。您可以稍后再看，或直接在社区中发布共享。',
    'emptySentRequestsTitle': '暂无申请记录',
    'emptySentRequestsDesc': '您尚未向任何共享额度或提供方发起过申请。',
    'emptyApprovalsTitle': '暂无待审批申请',
    'emptyApprovalsDesc': '当前没有任何等待您审批的额度申请。',
    'emptyMyAccessTitle': '暂无可用额度会话',
    'emptyMyAccessDesc': '您还没有已授权的共享会话。向社区中的共享额度发起申请即可开始使用。',
    'emptySharedByMeTitle': '暂无已授权共享',
    'emptySharedByMeDesc': '您尚未授权任何使用方使用您的额度。',
    'noEmailMatch': '没有匹配 "{query}" 的提供方或使用方邮箱。',

    // Dialogs
    'publishOfferDialogTitle': '发布共享额度',
    'publishOfferDialogSub': '从您绑定的提供方中划出一部分额度共享给社区成员。',
    'editOfferDialogTitle': '编辑共享额度',
    'editOfferDialogSub': '修改共享额度金额或有效期。',
    'shareSource': '共享来源',
    'offeredQuotaDollars': '共享额度金额 ($)',
    'availableToOffer': '当前可分配额度: ${amount}',
    'expirationDate': '有效期至',
    'optional': '选填',
    'publishOfferBtn': '确认发布',
    'updateOfferBtn': '保存修改',

    'askFriendsDialogTitle': '向好友求额度',
    'askFriendsDialogSub': '在工作区发布一条额度需求，所有算力提供方均可看到。',
    'requestedQuotaDollars': '期望申请额度 ($)',
    'neededByDate': '需要使用至',
    'postRequestBtn': '发布需求',

    'approveRequestDialogTitle': '审批额度申请',
    'approvedQuotaDollars': '批准额度 ($)',
    'approveRequestBtn': '确认批准',

    'addSessionQuotaDialogTitle': '追加会话额度',
    'resizeSessionDialogTitle': '调整共享会话额度',
    'additionalQuotaDollars': '追加额度 ($)',
    'grantedQuotaDollars': '已授予额度 ($)',
    'addQuotaBtn': '确认追加',
    'saveChangesBtn': '保存修改',

    'createKeyDialogTitle': '创建个人密钥',
    'createKeyDialogSub': '生成一个新的个人密钥，用于在 CLI 或编辑器中配置。',
    'keyName': '密钥名称',
    'keyNamePlaceholder': '例如: MacBook Pro, VS Code 工作站',
    'createKeyBtn': '确认创建',

    'keySecretDialogTitle': '个人访问密钥',
    'keySecretDialogSub': '请立即复制并妥善保存此密钥。为了安全起见，完整密钥仅展示一次。',
    'sessionKeyDialogTitle': '共享会话密钥',
    'sessionKeyDialogSub': '在您的客户端或代理配置中使用此密钥以接入共享算力。',
    'copyKey': '复制密钥',

    'linkCodexDialogTitle': '绑定 OpenAI Codex',
    'linkCodexDialogSub': '通过 OpenAI 官方设备授权接入。',
    'codexStep1Title': '1. 打开验证页面',
    'codexStep1Desc': '在浏览器中登录并确认您的 OpenAI 账户。',
    'codexStep2Title': '2. 输入一次性验证码',
    'codexStep2Desc': '在验证页面输入以下授权验证码：',
    'openVerificationPage': '打开验证页面',
    'copyCode': '复制验证码',
    'generatingDeviceCode': '正在生成设备授权码...',
    'cancelSignIn': '取消登录',

    'linkClaudeDialogTitle': '绑定 Claude 账户',
    'updateClaudeDialogTitle': '更新 Claude Token',
    'linkClaudeDialogSub': '通过 Setup Token 连接您的 Claude Code Enterprise 账户。',
    'claudeStep1Title': '1. 在终端中运行命令',
    'claudeStep1Desc': '通过 Claude Code CLI 生成安全的 Setup Token：',
    'claudeStep2Title': '2. 在下方粘贴 setup-token',
    'claudeStep2Desc': '粘贴由 CLI 生成的 Token（以 sk-ant-oat01- 开头）：',
    'saveClaudeAccount': '保存 Claude 账户',

    'linkAisDialogTitle': '绑定 AIS 项目',
    'editAisDialogTitle': '编辑 AIS 项目',
    'linkAisDialogSub': '接入您的 AIS / Compass LLM 项目凭证。',
    'aisProjectId': 'AIS 项目 ID',
    'aisProjectKey': 'AIS 项目密钥',
    'aisProjectKeyPlaceholder': '输入项目密钥',
    'aisProjectKeyLeaveEmpty': '留空则保持现有密钥不变',
    'howToGetAis': '如何获取 AIS 项目凭证？',
    'saveAisProject': '保存 AIS 项目',

    'aisGuideStep1Title': '1. 打开 Compass',
    'aisGuideStep1Desc': '在浏览器中访问 compass.llm.shopee.io 并登录，进入集成页面。',
    'aisGuideStep2Title': '2. 生成或获取项目密钥',
    'aisGuideStep2Desc': '打开浏览器 DevTools 控制台，粘贴并运行右侧脚本。',
    'aisGuideStep3Title': '3. 填入返回的配置',
    'aisGuideStep3Desc': '将控制台输出的 project_id 与 api_key 复制到表单中。',

    'revealCredentialsDialogTitle': '提供方凭证导出',
    'revealCredentialsDialogSub': '已绑定渠道的原始凭据，请严格保密。',

    // Admin Page
    'adminSubtitle': '保护隐私的安全概览，展示共享健康度、采纳率与结算用量。',
    'adminMembers': '成员总数',
    'adminLinkedProviders': '已绑定提供方',
    'adminActiveOffers': '生效中共享',
    'adminActiveSessions': '有效会话数',
    'adminPendingApprovals': '待审批申请',
    'adminOpenRequests': '求额度需求',
    'adminUsage': '用量统计',
    'adminSettledUsage': '已结算用量',
    'adminToday': '今日消耗',
    'adminRequests': '调用请求数',
    'adminSuccessRate': '请求成功率',
    'adminRequestFunnel': '审批漏斗',
    'adminTotalRequests': '总申请数',
    'adminApproved': '已批准',
    'adminRejected': '已拒绝',
    'adminApprovalRate': '通过率',
    'adminProviderHealth': '提供方健康度',
    'adminSharingActive': '正常共享中',
    'adminSharingPaused': '已暂停共享',
    'adminUnavailableProviders': '不可用提供方',
    'adminTopProviders': '结算用量最高的提供方',
    'adminTopConsumers': '结算用量最高的使用方',
    'adminRecentActivity': '近期共享动态',
    'adminLoadMore': '加载更多事件'
  }
};

const LanguageContext = createContext({
  language: 'en',
  setLanguage: () => {},
  t: (key, vars = {}) => key
});

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(() => {
    try {
      const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
      if (navigator.language && navigator.language.startsWith('zh')) return 'zh';
    } catch {}
    return 'en';
  });

  const setLanguage = useCallback((lang) => {
    setLanguageState(lang);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {}
  }, []);

  const t = useCallback((key, vars = {}) => {
    const dict = DICTIONARY[language] || DICTIONARY.en;
    let template = dict[key] ?? DICTIONARY.en[key] ?? key;
    if (typeof template === 'string') {
      for (const [vKey, val] of Object.entries(vars)) {
        template = template.replaceAll(`{${vKey}}`, String(val));
      }
    }
    return template;
  }, [language]);

  const value = { language, setLanguage, t };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
