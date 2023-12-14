import sinon from 'sinon';
import * as DeviceUtils from '../../src/device-utils';
import * as DeviceService from '../../src/data-service/device-service';
import chai from 'chai';
import sinonChai from 'sinon-chai';
import { DeviceModel, db } from '../../src/data-service/db';
import ip from 'ip';
import { addNewDevice } from '../../src/data-service/device-service';
import { DeviceFarmManager } from '../../src/device-managers';
import { Container } from 'typedi';
import { allocateDeviceForSession } from '../../src/device-utils';
import { DefaultPluginArgs } from '../../src/interfaces/IPluginArgs';
import { IDevice } from '../../src/interfaces/IDevice';

chai.should();
chai.use(sinonChai);
var expect = chai.expect;
var sandbox = sinon.createSandbox();

describe('Device Utils', () => {
  const hub1Device = {
    systemPort: 56205,
    sdk: '10',
    realDevice: true,
    name: 'emulator-5555',
    busy: false,
    state: 'device',
    udid: 'emulator-5555',
    platform: 'android',
    deviceType: 'real',
    host: 'http://192.168.0.225:4723',
    totalUtilizationTimeMilliSec: 40778,
    sessionStartTime: 1667113345897,
    offline: false,
    lastCmdExecutedAt: 1667113356356,
  };
  const hub2Device = {
    systemPort: 56205,
    sdk: '10',
    realDevice: true,
    name: 'emulator-5555',
    busy: false,
    state: 'device',
    udid: 'emulator-5555',
    platform: 'android',
    deviceType: 'real',
    host: 'http://192.168.0.226:4723',
    totalUtilizationTimeMilliSec: 40778,
    sessionStartTime: 1667113345897,
    offline: false,
    lastCmdExecutedAt: 1667113356356,
  };
  const localDeviceiOS = {
    name: 'iPhone SE (3rd generation)',
    udid: '14C1078F-74C1-4672-BDB7-B65FC85FBFB4',
    state: 'Shutdown',
    sdk: '16.0',
    platform: 'ios',
    wdaLocalPort: 53712,
    busy: false,
    realDevice: false,
    deviceType: 'simulator',
    host: `http://${ip.address()}:4723`,
    totalUtilizationTimeMilliSec: 0,
    sessionStartTime: 0,
    offline: false,
  };
  const devices = [hub1Device, hub2Device, localDeviceiOS] as unknown as IDevice[];

  const pluginArgs = Object.assign(DefaultPluginArgs, { remote: [`http://${ip.address()}:4723`], iosDeviceType: 'both', androidDeviceType: 'both' });

  afterEach(function () {
    sandbox.restore();
  });

  it('Allocating device should set device to be busy', async function () {
    DeviceModel.removeDataOnly();
    const deviceManager = new DeviceFarmManager('android', {androidDeviceType: 'both', iosDeviceType: 'both'}, 4723, Object.assign(pluginArgs, { maxSessions: 3 }));
    Container.set(DeviceFarmManager, deviceManager);
    addNewDevice(devices);
    const capabilities = {
      alwaysMatch: {
        platformName: 'android',
        'appium:app': '/Downloads/VodQA.apk',
        'appium:deviceAvailabilityTimeout': 1800,
        'appium:deviceRetryInterval': 100,
      },
      firstMatch: [{}],
    };
    let allocatedDeviceForFirstSession = await DeviceUtils.allocateDeviceForSession(capabilities, 1000, 1000, pluginArgs);

    let foundDevice = DeviceModel.chain().find({
      udid: allocatedDeviceForFirstSession.udid, 
      host: allocatedDeviceForFirstSession.host
    }).data()[0];

    expect(foundDevice.busy).to.be.true;

    function getFilterDeviceWithSameUDID() {
      return DeviceModel.chain().find({udid: 'emulator-5555'}).data();
    }

    const filterDeviceWithSameUDID = getFilterDeviceWithSameUDID();
    expect(filterDeviceWithSameUDID.length).to.be.equal(2);
    // one device should be busy and the other is not
    filterDeviceWithSameUDID.filter((device) => device.busy).length.should.be.equal(1);
    filterDeviceWithSameUDID.filter((device) => !device.busy).length.should.be.equal(1);


    let allocatedDeviceForSecondSession = await DeviceUtils.allocateDeviceForSession(capabilities, 1000, 1000, pluginArgs);
    let foundSecondDevice = DeviceModel.chain().find({udid: allocatedDeviceForSecondSession.udid, host: allocatedDeviceForSecondSession.host}).data()[0];

    expect(getFilterDeviceWithSameUDID()[0].busy).to.be.true;
    expect(getFilterDeviceWithSameUDID()[1].busy).to.be.true;
    expect(foundSecondDevice.busy).to.be.true;

    await allocateDeviceForSession(capabilities, 1000, 1000, pluginArgs).catch((error) =>
      expect(error)
        .to.be.an('error')
        .with.property(
          'message',
          'No device found for filters: {"platform":"android","name":"","udid":"emulator-5555","busy":false,"userBlocked":false}'
        )
    );
  });

  it('should release blocked devices that have no activity for more than the timeout', async () => {
    // Mock the dependencies and setup the test data
    const getAllDevicesMock = () => ([
      { udid: 'device1', busy: true, host: ip.address(), lastCmdExecutedAt: new Date().getTime() - ((DefaultPluginArgs.newCommandTimeoutSec + 5) * 1000)},
      { udid: 'device2', busy: true, host: ip.address(), lastCmdExecutedAt: new Date().getTime() - 30000, newCommandTimeout: 20000 / 1000 },
      { udid: 'device3', busy: true, host: ip.address(), lastCmdExecutedAt: new Date().getTime() },
      { udid: 'device4', busy: true, host: ip.address() },
    ]);
    
    sandbox.stub(DeviceService, 'getAllDevices').callsFake(<any>getAllDevicesMock);

    const unblockDeviceMock = sandbox.stub(DeviceService, 'unblockDevice').callsFake(sinon.fake());

    // Call the function under test
    await DeviceUtils.releaseBlockedDevices(DefaultPluginArgs.newCommandTimeoutSec);

    // Verify the expected behavior
    unblockDeviceMock.should.have.been.calledTwice;
    unblockDeviceMock.should.have.been.calledWith('device1', ip.address());
    unblockDeviceMock.should.have.been.calledWith('device2', ip.address());
    unblockDeviceMock.should.not.have.been.calledWith('device3', ip.address());
    unblockDeviceMock.should.not.have.been.calledWith('device3', ip.address());
  });

  it('should release device on node that is not used for more than the timeout', async () => {
    // spec: we have devices from different hosts, all of them are busy and one of them is not used for more than the timeout
    const getAllDevicesMock = () => ([
      { udid: 'device1', busy: true, host: 'http://anotherhost:4723', lastCmdExecutedAt: new Date().getTime() - 30000, newCommandTimeout: 20000 / 1000 },
      { udid: 'device2', busy: true, host: ip.address(), lastCmdExecutedAt: new Date().getTime() },
      // user blocked device
      { udid: 'device3', busy: true, host: ip.address(), userBlocked: true, lastCmdExecutedAt: new Date().getTime() - 30000, newCommandTimeout: 20000 / 1000 }
    ]);

    sandbox.stub(DeviceService, 'getAllDevices').callsFake(<any>getAllDevicesMock);

    const unblockDeviceMock = sandbox.stub(DeviceService, 'unblockDevice').callsFake(sinon.fake());
    
    // calling releaseBlockedDevices should release the device on anotherhost
    await DeviceUtils.releaseBlockedDevices(DefaultPluginArgs.newCommandTimeoutSec);

    // Verify the expected behavior
    unblockDeviceMock.should.have.been.calledOnce;
    unblockDeviceMock.should.have.been.calledWith('device1', 'http://anotherhost:4723' );
    unblockDeviceMock.should.have.not.been.calledWith('device3', ip.address());
  })

  it('Block and unblock device', async () => {
      DeviceModel.removeDataOnly();
      // mock setUtilizationTime
      sandbox.stub(DeviceUtils, <any> 'setUtilizationTime').callsFake(sinon.fake());
    
    
      const unbusyDevices = devices.map((device) => ({ ...device, busy: false })) as unknown as IDevice[];
      addNewDevice(unbusyDevices);

      const targetDevice = unbusyDevices[0];

      
      // action: block device
      DeviceService.blockDevice(targetDevice.udid, targetDevice.host);
  
      // assert device is busy
      expect(DeviceModel.chain().find({ udid: targetDevice.udid, host: targetDevice.host }).data()[0]).to.have.property('busy', true);
    
      // set lastCommandTimestamp, otherwise it won't be picked up as device to unblock
      DeviceModel.chain()
        .find({ udid: targetDevice.udid, host: targetDevice.host })
        .update(function (device: IDevice) {
          device.lastCmdExecutedAt = new Date().getTime();
        });
  
      let unblockCandidates = await DeviceUtils.unblockCandidateDevices();
      //console.log(unblockCandidates);
  
      // assert: device should be part of candidate list to unblock
      expect(unblockCandidates.map((item) => item.udid)).to.include(targetDevice.udid);
      
      // action: release blocked devices
      await DeviceService.unblockDevice(targetDevice.udid, targetDevice.host);
  
      // assert: device should not be part of candidate list to unblock
      unblockCandidates =  await DeviceUtils.unblockCandidateDevices();
      expect((await unblockCandidates).map((item) => item.udid)).to.not.include(targetDevice.udid);
  
      // assert: device should not have lastCommandTimestamp or it should be undefined

      const device = DeviceModel.chain().find({ udid: targetDevice.udid, host: targetDevice.host }).data()[0]
      expect(device).to.be.not.undefined;
      expect(device?.lastCmdExecutedAt).to.be.undefined;
      
  })
  
});