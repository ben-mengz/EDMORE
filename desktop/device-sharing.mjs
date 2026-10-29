import { loadFeatureModule } from './feature-loader.mjs'
export const { DeviceSharing, localDeviceRows } = await loadFeatureModule('remote', 'desktop/device-sharing.mjs')
