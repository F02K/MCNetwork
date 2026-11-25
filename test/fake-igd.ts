import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Call {
  action: string;
  args: Record<string, string>;
}

export interface FakeRouter {
  /** UDP port that answers the discovery (give it to Upnp as ssdpPort). */
  ssdpPort: number;
  calls: Call[];
  /** Mappings currently held, by "port/TCP". */
  mappings: Map<string, Record<string, string>>;
  close(): Promise<void>;
}

const description = (port: number) => `<?xml version="1.0"?><root><URLBase>http://127.0.0.1:${port}/</URLBase><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><friendlyName>Test Router</friendlyName><deviceList><device><deviceList><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/common</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl</controlURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>`;

const fault = (code: number, text: string) => `<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${text}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

/** A router that speaks just enough UPnP: discovery over UDP and the three port mapping actions over HTTP. */
export async function fakeRouter(opts: { externalIp?: string; onlyPermanent?: boolean; refuse?: boolean } = {}): Promise<FakeRouter> {
  const calls: Call[] = [];
  const mappings = new Map<string, Record<string, string>>();
  const http: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET') return void res.end(description((http.address() as AddressInfo).port));
      const body = Buffer.concat(chunks).toString('utf8');
      const action = /#(\w+)"?$/.exec(String(req.headers.soapaction))?.[1] ?? '';
      const args = Object.fromEntries([...body.matchAll(/<(New\w+)>([^<]*)<\/\1>/g)].map((m) => [m[1], m[2]]));
      calls.push({ action, args });
      const send = (status: number, text: string) => {
        res.writeHead(status, { 'content-type': 'text/xml' });
        res.end(text);
      };
      if (action === 'GetExternalIPAddress') return send(200, `<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${opts.externalIp ?? '203.0.113.9'}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
      if (action === 'AddPortMapping') {
        if (opts.refuse) return send(500, fault(501, 'Action Failed'));
        if (opts.onlyPermanent && args.NewLeaseDuration !== '0') return send(500, fault(725, 'OnlyPermanentLeasesSupported'));
        mappings.set(`${args.NewExternalPort}/TCP`, args);
        return send(200, '<s:Envelope><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>');
      }
      if (action === 'DeletePortMapping') {
        if (!mappings.delete(`${args.NewExternalPort}/TCP`)) return send(500, fault(714, 'NoSuchEntryInArray'));
        return send(200, '<s:Envelope><s:Body><u:DeletePortMappingResponse/></s:Body></s:Envelope>');
      }
      return send(500, fault(401, 'Invalid Action'));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const httpPort = (http.address() as AddressInfo).port;
  const udp: Socket = createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    if (!msg.toString().startsWith('M-SEARCH')) return;
    udp.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=100\r\nLOCATION: http://127.0.0.1:${httpPort}/desc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n`, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  return {
    ssdpPort: udp.address().port,
    calls,
    mappings,
    close: () =>
      new Promise<void>((r) => {
        udp.close();
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
}
