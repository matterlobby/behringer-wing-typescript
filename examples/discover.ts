import { Wing } from '../src';

async function main(): Promise<void> {
  console.log('Scanning for Wing consoles...');
  const devices = await Wing.scan();
  if (!devices.length) {
    console.log('No devices found.');
    return;
  }
  console.log('Discovered devices:');
  devices.forEach((device, index) => {
    console.log(
      `[${index}] ${device.name} (${device.model}) @ ${device.ip} serial=${device.serial} fw=${device.firmware}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
