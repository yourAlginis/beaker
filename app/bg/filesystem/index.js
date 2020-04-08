import { BrowserWindow } from 'electron'
import { join as joinPath } from 'path'
import * as logLib from '../logger'
const logger = logLib.category('filesystem')
import hyper from '../hyper/index'
import * as db from '../dbs/profile-data-db'
import * as archivesDb from '../dbs/archives'
import * as bookmarks from './bookmarks'
import * as trash from './trash'
import * as modals from '../ui/subwindows/modals'
import { PATHS } from '../../lib/const'
import lock from '../../lib/lock'

// typedefs
// =

/**
 * @typedef {import('../hyper/daemon').DaemonHyperdrive} DaemonHyperdrive
 * @typedef {import('../dbs/archives').LibraryArchiveMeta} LibraryArchiveMeta
 * 
 * @typedef {Object} DriveConfig
 * @property {string} key
 * @property {Object} [forkOf]
 * @property {string} [forkOf.key]
 * @property {string} [forkOf.label]
 * 
 * @typedef {Object} DriveIdent
 * @property {boolean} system
 */

// globals
// =

var browsingProfile
var rootDrive
var drives = []

// exported api
// =

/**
 * @returns {DaemonHyperdrive}
 */
export function get () {
  return rootDrive
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isRootUrl (url) {
  return url === browsingProfile.url
}

/**
 * @returns {Promise<void>}
 */
export async function setup () {
  trash.setup()

  // create the root drive as needed
  var isInitialCreation = false
  browsingProfile = await db.get(`SELECT * FROM profiles WHERE id = 0`)
  if (!browsingProfile.url) {
    let drive = await hyper.drives.createNewRootDrive()
    logger.info('Root drive created', {url: drive.url})
    await db.run(`UPDATE profiles SET url = ? WHERE id = 0`, [drive.url])
    browsingProfile.url = drive.url
    isInitialCreation = true
  }

  // load root drive
  rootDrive = await hyper.drives.getOrLoadDrive(browsingProfile.url, {persistSession: true})
  
  // enforce root files structure
  logger.info('Loading root drive', {url: browsingProfile.url})
  try {
    // ensure common dirs
    await ensureDir(PATHS.BOOKMARKS)

    // default bookmarks
    if (isInitialCreation) {
      await bookmarks.add({href: 'https://beaker-browser.gitbook.io/docs/', title: 'Beaker Documentation', pinned: true})
      await bookmarks.add({href: 'https://www.reddit.com/r/beakerbrowser/', title: 'Beaker Community Reddit', pinned: true})
    }

    // ensure all user mounts are set
    // TODO
    // for (let user of userList) {
    // }
  } catch (e) {
    console.error('Error while constructing the root drive', e.toString())
    logger.error('Error while constructing the root drive', {error: e.toString()})
  }

  // load drive config
  try {
    drives = JSON.parse(await rootDrive.pda.readFile('/drives.json')).drives
  } catch (e) {
    logger.info('Error while reading the drive configuration at /drives.json', {error: e.toString()})
  }
}

/**
 * @param {string} url 
 * @returns {DriveIdent}
 */
export function getDriveIdent (url) {
  return {system: isRootUrl(url)}
}

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.includeSystem]
 * @returns {Array<DriveConfig>}
 */
export function listDrives ({includeSystem} = {includeSystem: false}) {
  var d = drives.slice()
  if (includeSystem) {
    d.unshift({key: rootDrive.url.slice('hyper://'.length)})
  }
  return d
}

/**
 * @returns {Promise<Array<LibraryArchiveMeta>>}
 */
export async function listDriveMetas () {
  return Promise.all(drives.map(d => archivesDb.getMeta(d.key)))
}

/**
 * @param {string} key
 * @returns {DriveConfig}
 */
export function getDriveConfig (key) {
  return listDrives().find(d => d.key === key)
}

/**
 * @param {string} url
 * @param {Object} [opts]
 * @param {Object} [opts.forkOf]
 * @returns {Promise<void>}
 */
export async function configDrive (url, {forkOf} = {forkOf: undefined}) {
  var release = await lock('filesystem:drives')
  try {
    var key = await hyper.drives.fromURLToKey(url, true)
    var driveCfg = drives.find(d => d.key === key)
    if (!driveCfg) {
      let drive = await hyper.drives.getOrLoadDrive(url)
      let manifest = await drive.pda.readManifest().catch(_ => {})

      driveCfg = /** @type DriveConfig */({key})
      if (forkOf && typeof forkOf === 'object') {
        driveCfg.forkOf = forkOf
      }

      if (!drive.writable) {
        // seed the drive
        drive.session.drive.configureNetwork({
          announce: true,
          lookup: true
        })
      }

      // for forks, we need to ensure:
      // 1. the drives.json forkOf.key is the same as index.json forkOf value
      // 2. there's a local forkOf.label
      // 3. the parent is saved
      if (manifest.forkOf && typeof manifest.forkOf === 'string') {
        if (!driveCfg.forkOf) driveCfg.forkOf = {key: undefined, label: undefined}
        driveCfg.forkOf.key = await hyper.drives.fromURLToKey(manifest.forkOf, true)
        if (!driveCfg.forkOf.label) {
          let message = 'Choose a label to save this fork under (e.g. "dev" or "bobs-changes")'
          let promptRes = await modals.create(BrowserWindow.getFocusedWindow().webContents, 'prompt', {message}).catch(e => false)
          if (!promptRes || !promptRes.value) return
          driveCfg.forkOf.label = promptRes.value
        }

        let parentDriveCfg = drives.find(d => d.key === driveCfg.forkOf.key)
        if (!parentDriveCfg) {
          drives.push({key: driveCfg.forkOf.key})
        }
      }

      drives.push(driveCfg)
    } else {
      if (typeof forkOf !== 'undefined') {
        if (forkOf && typeof forkOf === 'object') {
          driveCfg.forkOf = forkOf
        } else {
          delete driveCfg.forkOf
        }
      }
    }
    await rootDrive.pda.writeFile('/drives.json', JSON.stringify({drives}, null, 2))
  } finally {
    release()
  }
}

/**
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function removeDrive (url) {
  var release = await lock('filesystem:drives')
  try {
    var key = await hyper.drives.fromURLToKey(url, true)
    var driveIndex = drives.findIndex(drive => drive.key === key)
    if (driveIndex === -1) return
    let drive = await hyper.drives.getOrLoadDrive(url)
    if (!drive.writable) {
      // unseed the drive
      drive.session.drive.configureNetwork({
        announce: false,
        lookup: true
      })
    }
    drives.splice(driveIndex, 1)
    await rootDrive.pda.writeFile('/drives.json', JSON.stringify({drives}, null, 2))
  } finally {
    release()
  }
}

/**
 * @param {string} containingPath
 * @param {string} basename
 * @param {string} [ext]
 * @param {string} [joiningChar]
 * @returns {Promise<string>}
 */
export async function getAvailableName (containingPath, basename, ext = undefined, joiningChar = '-') {
  for (let i = 1; i < 1e9; i++) {
    let name = ((i === 1) ? basename : `${basename}${joiningChar}${i}`) + (ext ? `.${ext}` : '')
    let st = await stat(joinPath(containingPath, name))
    if (!st) return name
  }
  // yikes if this happens
  throw new Error('Unable to find an available name for ' + basename)
}

export async function setupDefaultProfile ({title, description, thumbBase64, thumbExt}) {
  var drive = await hyper.drives.createNewDrive({title, description})
  if (thumbBase64) {
    await drive.pda.writeFile(`/thumb.${thumbExt || 'png'}`, thumbBase64, 'base64')
  }
  await drive.pda.writeFile('/index.html', `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
  </head>
  <body>
    <img src="/thumb">
    <h1>${title}</h1>
    ${description ? `<p>${description}</p>` : ''}
  </body>
</html>`)

  var addressBook
  try { addressBook = await rootDrive.pda.readFile('/address-book.json').then(JSON.parse) }
  catch (e) { addressBook = {} }
  addressBook.profiles = addressBook.profiles || []
  addressBook.profiles.push({
    key: drive.key.toString('hex'),
    title,
    description
  })
  await rootDrive.pda.writeFile('/address-book.json', JSON.stringify(addressBook, null, 2))
}

export async function getProfile () {
  var addressBook
  try { addressBook = await rootDrive.pda.readFile('/address-book.json').then(JSON.parse) }
  catch (e) { console.error(e); addressBook = {} }
  return addressBook.profiles ? addressBook.profiles[0] : undefined
}

// internal methods
// =

async function stat (path) {
  try { return await rootDrive.pda.stat(path) }
  catch (e) { return null }
}

async function ensureDir (path) {
  try {
    let st = await stat(path)
    if (!st) {
      logger.info(`Creating directory ${path}`)
      await rootDrive.pda.mkdir(path)
    } else if (!st.isDirectory()) {
      logger.error('Warning! Filesystem expects a folder but an unexpected file exists at this location.', {path})
    }
  } catch (e) {
    logger.error('Filesystem failed to make directory', {path: '' + path, error: e.toString()})
  }
}

async function ensureMount (path, url) {
  try {
    let st = await stat(path)
    let key = await hyper.drives.fromURLToKey(url, true)
    if (!st) {
      // add mount
      logger.info(`Adding mount ${path}`, {key})
      await rootDrive.pda.mount(path, key)
    } else if (st.mount) {
      if (st.mount.key.toString('hex') !== key) {
        // change mount
        logger.info('Reassigning mount', {path, key, oldKey: st.mount.key.toString('hex')})
        await rootDrive.pda.unmount(path)
        await rootDrive.pda.mount(path, key)
      }
    } else {
      logger.error('Warning! Filesystem expects a mount but an unexpected file exists at this location.', {path})
    }
  } catch (e) {
    logger.error('Filesystem failed to mount drive', {path, url, error: e.toString()})
  }
}

async function ensureUnmount (path) {
  try {
    let st = await stat(path)
    if (st && st.mount) {
      // remove mount
      logger.info('Removing mount', {path})
      await rootDrive.pda.unmount(path)
    }
  } catch (e) {
    logger.error('Filesystem failed to unmount drive', {path, error: e.toString()})
  }
}