import { loadFeatureModule } from './feature-loader.mjs'
export const { installWikiNavigation } = await loadFeatureModule('wiki', 'desktop/wiki-navigation.mjs')
