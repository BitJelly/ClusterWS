import { BrokerClient } from './client';
import { generateKey, logError, random } from '../../utils/functions';
import { WebSocket, WebSocketServer, ConnectionInfo } from '@clusterws/uws';
import { Options, Listener, Message, HorizontalScaleOptions } from '../../utils/types';

type SocketExtend = {
  id: string,
  channels: { [key: string]: number }
};

export class Broker {
  private server: WebSocketServer;
  private sockets: Array<WebSocket & SocketExtend> = [];
  private scalers: BrokerClient[] = [];
  private nextScaler: number = random(0, this.options.brokers - 1)

  constructor(private options: Options, port: number, securityKey: string) {
    this.server = new WebSocketServer({
      port,
      verifyClient: (info: ConnectionInfo, next: Listener): void => {
        next(info.req.url === `/?token=${securityKey}`);
      }
    }, (): void => process.send({ event: 'READY', pid: process.pid }));

    this.server.on('connection', (socket: WebSocket & SocketExtend): void => {
      socket.id = generateKey(8);
      socket.channels = {};
      this.sockets.push(socket);

      socket.on('message', (message: string | Buffer): void | boolean => {
        if (typeof message === 'string') {
          const [type, data]: any = JSON.parse(message);

          if (type === 'u') {
            return delete socket.channels[data];
          }

          if (typeof data === 'string') {
            socket.channels[data] = 1;
          } else {
            for (let i: number = 0, len: number = data.length; i < len; i++) {
              socket.channels[data[i]] = 1;
            }
          }
        } else {
          this.broadcastMessage(socket.id, JSON.parse(Buffer.from(message) as any));
        }
      });

      socket.on('error', (err: Error): void => { /** ignore error */ });
      socket.on('close', (code: number, reason: string): void => {
        socket.channels = {};
        for (let i: number = 0, len: number = this.sockets.length; i < len; i++) {
          if (this.sockets[i].id === socket.id) {
            this.sockets.splice(i, 1);
            break;
          }
        }
        socket = null;
      });
    });

    this.server.startAutoPing(20000);
    this.connectScaler(this.options.horizontalScaleOptions);
  }

  private connectScaler(horizontalScaleOptions: HorizontalScaleOptions): void {
    if (horizontalScaleOptions.masterOptions) {
      // move this to separate function
      const masterUrl: string = `${horizontalScaleOptions.masterOptions.tlsOptions ? 'wss' : 'ws'}://127.0.0.1:${horizontalScaleOptions.masterOptions.port}`;
      const scalerClient = new BrokerClient(`${masterUrl}/token=${horizontalScaleOptions.key || ''}`);
      scalerClient.on('message', (msg: Message) => {
        // handle message
      });
      this.scalers.push(scalerClient);
    }

    // connect to all other scalers 
  }

  private broadcastMessage(id: string, message: Message): void {
    const messageKeys: string[] = Object.keys(message);
    for (let i: number = 0, len: number = this.sockets.length; i < len; i++) {
      const socket: WebSocket & SocketExtend = this.sockets[i];
      if (socket.id !== id) {
        let pass: boolean = false;
        const readyMessage: Message = {};

        for (let j: number = 0, keysLen: number = messageKeys.length; j < keysLen; j++) {
          const key: string = messageKeys[j];
          if (socket.channels[key]) {
            pass = true;
            readyMessage[key] = message[key];
          }
        }

        if (pass && socket.readyState === socket.OPEN) {
          socket.send(Buffer.from(JSON.stringify(readyMessage)));
        }
      }
    }
  }
}