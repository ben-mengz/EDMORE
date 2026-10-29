export const modelProviders = [{
  id: 'llm3-hu', displayName: 'HU LLM', model: 'llm3',
  baseURL: 'https://llm3-compute.cms.hu-berlin.de/v1',
  apiKeyEnv: 'EDMORE_HU_LLM_API_KEY', concurrency: 4, required: true,
}]
