import { loadFeatureModule } from './feature-loader.mjs'
export const { WeKnora } = await loadFeatureModule('wiki', 'desktop/weknora.mjs')
