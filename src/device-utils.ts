/* eslint-disable no-prototype-builtins */
import { isMac, checkIfPathIsAbsolute, isDeviceFarmRunning, cachePath } from './helpers';
import { ServerCLI } from './types/CLIArgs';
import { Platform } from './types/Platform';
import { androidCapabilities, iOSCapabilities } from './CapabilityManager';
import waitUntil from 'async-wait-until';
import { ISessionCapability } from './interfaces/ISessionCapability';
import { IDeviceFilterOptions } from './interfaces/IDeviceFilterOptions';
import { IDevice } from './interfaces/IDevice';
import { Container } from 'typedi';
import { DeviceFarmManager } from './device-managers';
import {
  updateDevice,
  unblockDevice,
  getAllDevices,
  getDevice,
  setSimulatorState,
  addNewDevice,
  removeDevice,
} from './data-service/device-service';
import log from './logger';
import DevicePlatform from './enums/Platform';
import _ from 'lodash';
import fs from 'fs';
import { LocalStorage } from 'node-persist';
import CapabilityManager from './device-managers/cloud/CapabilityManager';
import IOSDeviceManager from './device-managers/IOSDeviceManager';
import NodeDevices from './device-managers/NodeDevices';
import ip from 'ip';
import { getCLIArgs } from './data-service/pluginArgs';
import { DevicePlugin } from './plugin';

const customCapability = {
  deviceTimeOut: 'appium:deviceAvailabilityTimeout',
  deviceQueryInteval: 'appium:deviceRetryInterval',
  iphoneOnly: 'appium:iPhoneOnly',
  ipadOnly: 'appium:iPadOnly',
  udids: 'appium:udids',
  minSDK: 'appium:minSDK',
  maxSDK: 'appium:maxSDK',
};

let timer: any;
let cronTimerToReleaseBlockedDevices: any;
let cronTimerToUpdateDevices: any;

export const getDeviceTypeFromApp = (app: string) => {
  /* If the test is targeting safarim, then app capability will be empty */
  if (!app) {
    return;
  }
  return app.endsWith('app') || app.endsWith('zip') ? 'simulator' : 'real';
};

export function isAndroid(cliArgs: ServerCLI) {
  return cliArgs.Platform.toLowerCase() === DevicePlatform.ANDROID;
}

export function deviceType(cliArgs: any, device: string) {
  const iosDeviceType = cliArgs.plugin['device-farm'].iosDeviceType;
  if (_.has(cliArgs, 'plugin["device-farm"].iosDeviceType')) {
    return iosDeviceType === device || iosDeviceType === 'both';
  }
}

export function isIOS(cliArgs: any) {
  return isMac() && cliArgs.plugin['device-farm'].platform.toLowerCase() === DevicePlatform.IOS;
}

export function isAndroidAndIOS(cliArgs: ServerCLI) {
  return isMac() && cliArgs.Platform.toLowerCase() === DevicePlatform.BOTH;
}

export function isDeviceConfigPathAbsolute(path: string) {
  if (checkIfPathIsAbsolute(path)) {
    return true;
  } else {
    throw new Error(`Device Config Path ${path} should be absolute`);
  }
}

/**
 * For given capability, wait untill a free device is available from the database
 * and update the capability json with required device informations
 * @param capability
 * @returns
 */
export async function allocateDeviceForSession(
  capability: ISessionCapability,
  deviceTimeOutMs: number,
  deviceQueryIntervalMs: number,
): Promise<IDevice> {
  const firstMatch = Object.assign({}, capability.firstMatch[0], capability.alwaysMatch);
  console.log(firstMatch);
  const filters = getDeviceFiltersFromCapability(firstMatch);
  log.info(JSON.stringify(filters));
  const timeout = firstMatch[customCapability.deviceTimeOut] || deviceTimeOutMs;
  const newCommandTimeout = firstMatch['appium:newCommandTimeout'] || undefined;
  const intervalBetweenAttempts =
    firstMatch[customCapability.deviceQueryInteval] || deviceQueryIntervalMs;

  try {
    await waitUntil(
      async () => {
        const maxSessions = getDeviceManager().getMaxSessionCount();
        if (maxSessions !== undefined && (await getBusyDevicesCount()) === maxSessions) {
          log.info(
            `Waiting for session available, already at max session count of: ${maxSessions}`,
          );
          return false;
        } else log.info('Waiting for free device');
        return (await getDevice(filters)) != undefined;
      },
      { timeout, intervalBetweenAttempts },
    );
  } catch (err) {
    throw new Error(`No device found for filters: ${JSON.stringify(filters)}`);
  }
  const device = getDevice(filters);
  log.info(`📱 Device found: ${JSON.stringify(device)}`);
  updateDevice(device, { busy: true, newCommandTimeout: newCommandTimeout });
  log.info(`📱 Blocking device ${device.udid} for new session`);
  await updateCapabilityForDevice(capability, device);
  return device;
}

export async function updateCapabilityForDevice(capability: any, device: IDevice) {
  if (!device.hasOwnProperty('cloud')) {
    if (device.platform.toLowerCase() == DevicePlatform.ANDROID) {
      await androidCapabilities(capability, device);
    } else {
      await iOSCapabilities(capability, device);
    }
  } else {
    log.info('Updating cloud capability for Device');
    return new CapabilityManager(capability, device).getCapability();
  }
}

/**
 * Sets up node-persist storage in local cache
 * @returns storage
 */
export async function initlializeStorage() {
  const basePath = cachePath('storage');
  await fs.promises.mkdir(basePath, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const storage = require('node-persist');
  const localStorage = storage.create({ dir: basePath });
  await localStorage.init();
  Container.set('LocalStorage', localStorage);
}

function getStorage() {
  return Container.get('LocalStorage') as LocalStorage;
}

/**
 * Gets utlization time for a device from storage
 * Returns 0 if the device has not been used an thus utilization time has not been saved
 * @param udid
 * @returns number
 */
export async function getUtilizationTime(udid: string) {
  try {
    const value = await getStorage().getItem(udid);
    if (value !== undefined && value && !isNaN(value)) {
      return value;
    } else {
      //log.error(`Custom Exception: Utilizaiton time in cache is corrupted. Value = '${value}'.`);
    }
  } catch (err) {
    log.error(`Failed to fetch Utilization Time \n ${err}`);
  }

  return 0;
}

/**
 * Sets utilization time for a device to storage
 * @param udid
 * @param utilizationTime
 */
export async function setUtilizationTime(udid: string, utilizationTime: number) {
  await getStorage().setItem(udid, utilizationTime);
}

/**
 * Method to get the device filters from the custom session capability
 * This filter will be used as in the query to find the free device from the databse
 * @param capability
 * @returns IDeviceFilterOptions
 */
export function getDeviceFiltersFromCapability(capability: any): IDeviceFilterOptions {
  const platform: Platform = capability['platformName'].toLowerCase();
  const udids = capability[customCapability.udids]
    ? capability[customCapability.udids].split(',').map(_.trim)
    : process.env.UDIDS?.split(',').map(_.trim);
  /* Based on the app file extension, we will decide whether to run the
   * test on real device or simulator.
   *
   * Applicaple only for ios.
   */
  const deviceType =
    platform == DevicePlatform.IOS
      ? getDeviceTypeFromApp(capability['appium:app'] as string)
      : undefined;
  if (
    deviceType?.startsWith('sim') &&
    getCLIArgs()[0].plugin['device-farm'].iosDeviceType.startsWith('real')
  ) {
    throw new Error(
      'iosDeviceType value is set to "real" but app provided is not suitable for real device.',
    );
  }
  if (
    deviceType?.startsWith('real') &&
    getCLIArgs()[0].plugin['device-farm'].iosDeviceType.startsWith('sim')
  ) {
    throw new Error(
      'iosDeviceType value is set to "simulated" but app provided is not suitable for simulator device.',
    );
  }
  let name = '';
  if (capability[customCapability.ipadOnly]) {
    name = 'iPad';
  } else if (capability[customCapability.iphoneOnly]) {
    name = 'iPhone';
  }
  return {
    platform,
    platformVersion: capability['appium:platformVersion']
      ? capability['appium:platformVersion']
      : undefined,
    name,
    deviceType,
    udid: udids?.length ? udids : capability['appium:udid'],
    busy: false,
    userBlocked: false,
    minSDK: capability[customCapability.minSDK] ? capability[customCapability.minSDK] : undefined,
    maxSDK: capability[customCapability.maxSDK] ? capability[customCapability.maxSDK] : undefined,
  };
}

/**
 * Helper methods to manage devices
 */
function getDeviceManager() {
  return Container.get(DeviceFarmManager) as DeviceFarmManager;
}

export async function getBusyDevicesCount() {
  const allDevices = getAllDevices();
  return allDevices.filter((device) => {
    return device.busy;
  }).length;
}

export async function updateDeviceList(hubArgument?: string) {
  const devices: Array<IDevice> = await getDeviceManager().getDevices(getAllDevices());
  if (hubArgument) {
    const nodeDevices = new NodeDevices(hubArgument);
    try {
      await nodeDevices.postDevicesToHub(devices, 'add');
    } catch (error) {
      log.error(`Cannot send device list update. Reason: ${error}`);
    }
  }
  addNewDevice(devices);

  return devices;
}

export async function refreshSimulatorState(cliArgs: ServerCLI) {
  if (timer) {
    clearInterval(timer);
  }
  timer = setInterval(async () => {
    const simulators = await new IOSDeviceManager().getSimulators(cliArgs);
    await setSimulatorState(simulators);
  }, 10000);
}

export async function setupCronCheckStaleDevices(
  intervalMs: number,
) {
  const nodeChecked: Array<string> = [];

  setInterval(async () => {
    const devices = new Set();

    const allDevices = getAllDevices();
    allDevices.forEach((device: IDevice) => {
      if (!device.host.includes(ip.address()) && !nodeChecked.includes(device.host)) {
        devices.add(device);
      }
    });

    const iterableSet = [...devices];
    const nodeConnections = iterableSet.map(async (device: any) => {
      nodeChecked.push(device.host);
      await DevicePlugin.waitForRemoteDeviceFarmToBeRunning(device.host);
      return device.host;
    });

    const nodeConnectionsResult = await Promise.allSettled(nodeConnections);

    const nodeConnectionsSuccess = nodeConnectionsResult.filter(
      (result) => result.status === 'fulfilled',
    );
    const nodeConnectionsSuccessHost = nodeConnectionsSuccess.map((result: any) => result.value);
    const nodeConnectionsSuccessHostSet = new Set(nodeConnectionsSuccessHost);

    const nodeConnectionsFailureHostSet = new Set(
      [...devices].filter((device: any) => !nodeConnectionsSuccessHostSet.has(device.host)),
    );

    nodeConnectionsFailureHostSet.forEach((device: any) => {
      log.info(`Removing Device with udid (${device.udid}) because it is not available`);
      removeDevice(device);
      nodeChecked.splice(nodeChecked.indexOf(device.host), 1);
    });
  }, intervalMs);
}

export async function releaseBlockedDevices(newCommandTimeout: number) {
  const allDevices = getAllDevices();
  const busyDevices = allDevices.filter((device) => {
    return device.busy && device.host.includes(ip.address());
  });
  busyDevices.forEach(function (device) {
    if (device.lastCmdExecutedAt == undefined) {
      return;
    }

    const currentEpoch = new Date().getTime();
    const timeoutSeconds =
      device.newCommandTimeout != undefined
        ? device.newCommandTimeout
        : newCommandTimeout;
    const timeSinceLastCmdExecuted = (currentEpoch - device.lastCmdExecutedAt) / 1000;
    if (timeSinceLastCmdExecuted > timeoutSeconds) {
      // unblock regardless of whether the device has session or not
      unblockDevice({ udid: device.udid });
      log.info(
        `📱 Unblocked device with udid ${device.udid} as there is no activity from client for more than ${timeoutSeconds}. Last command was ${timeSinceLastCmdExecuted} seconds ago.`,
      );
    }
  });
}

export async function setupCronReleaseBlockedDevices(intervalMs: number, newCommandTimeoutSec: number) {
  if (cronTimerToReleaseBlockedDevices) {
    clearInterval(cronTimerToReleaseBlockedDevices);
  }
  await releaseBlockedDevices(newCommandTimeoutSec);
  cronTimerToReleaseBlockedDevices = setInterval(async () => {
    await releaseBlockedDevices(newCommandTimeoutSec);
  }, intervalMs);
}

export async function setupCronUpdateDeviceList(
  hubArgument: string,
  intervalMs: number,
) {
  if (cronTimerToUpdateDevices) {
    clearInterval(cronTimerToUpdateDevices);
  }
  log.info(
    `This node will send device list update to the hub (${hubArgument}) every ${intervalMs} ms`,
  );

  cronTimerToUpdateDevices = setInterval(async () => {
    if (await isDeviceFarmRunning(hubArgument)) {
      await updateDeviceList(hubArgument);
    } else {
      log.warn(`Not sending device update since hub ${hubArgument} is not running`);
    }
  }, intervalMs);
}
