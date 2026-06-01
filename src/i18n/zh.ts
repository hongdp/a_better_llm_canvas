import type { TranslationDictionary } from './index'

export const zh: TranslationDictionary = {
  app: {
    sidebarToggle: '切换侧边栏',
    activeModel: '模型:',
    settingsTitle: '设置',
    exportDoc: '导出文档',
    historyToggle: '切换版本历史',
    chatTitle: '对话',
    diffReview: {
      title: '审查更改',
      acceptAll: '全部接受',
      rejectAll: '全部拒绝',
    },
    errorTitle: '错误',
    dismiss: '忽略',
    systemPrompt: '系统提示词:',
  },
  settings: {
    title: '设置',
    tabs: {
      models: '模型与 API 密钥',
      appearance: '外观',
      data: '数据与存储',
    },
    theme: {
      title: '主题',
      dark: '深色模式',
      light: '浅色模式',
    },
    language: {
      title: '语言',
      en: 'English',
      zh: '中文',
    },
    apiKey: 'API 密钥',
    baseUrl: '基础 URL',
    modelName: '模型名称',
    save: '保存更改',
  },
}
