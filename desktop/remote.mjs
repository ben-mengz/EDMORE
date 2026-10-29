import { Supervisor } from './supervisor.mjs'
import { remoteOrigin } from './config.mjs'
import { loadFeatureModule } from './feature-loader.mjs'
const feature = await loadFeatureModule('remote', 'desktop/remote.mjs')
export const remotePartition = feature.remotePartition
export const RemoteConnection = feature.createRemoteConnection(Supervisor, remoteOrigin)
