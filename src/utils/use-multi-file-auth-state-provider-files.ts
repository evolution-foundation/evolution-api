/**
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ @author jrCleber                                                             │
 * │ @filename use-multi-file-auth-state-provider-files.ts                              │
 * │ Developed by: Cleber Wilson                                                  │
 * │ Creation date: May 31, 2024                                                 │
 * │ Contact: contato@codechat.dev                                                │
 * ├──────────────────────────────────────────────────────────────────────────────┤
 * │ @copyright © Cleber Wilson 2023. All rights reserved.                        │
 * │ Licensed under the Apache License, Version 2.0                               │
 * │                                                                              │
 * │  @license "https://github.com/code-chat-br/whatsapp-api/blob/main/LICENSE"   │
 * │                                                                              │
 * │ You may not use this file except in compliance with the License.             │
 * │ You may obtain a copy of the License at                                      │
 * │                                                                              │
 * │    http://www.apache.org/licenses/LICENSE-2.0                                │
 * │                                                                              │
 * │ Unless required by applicable law or agreed to in writing, software          │
 * │ distributed under the License is distributed on an "AS IS" BASIS,            │
 * │ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.     │
 * │                                                                              │
 * │ See the License for the specific language governing permissions and          │
 * │ limitations under the License.                                               │
 * │                                                                              │
 * │ @type {AuthState}                                                            │
 * │ @function useMultiFileAuthStateRedisDb                                       │
 * │ @returns {Promise<AuthState>}                                                │
 * ├──────────────────────────────────────────────────────────────────────────────┤
 * │ @important                                                                   │
 * │ For any future changes to the code in this file, it is recommended to        │
 * │ contain, together with the modification, the information of the developer    │
 * │ who changed it and the date of modification.                                 │
 * └──────────────────────────────────────────────────────────────────────────────┘
 */

import { ProviderFiles } from '@api/provider/sessions';
import { Logger } from '@config/logger.config';
import { AuthenticationCreds, AuthenticationState, BufferJSON, initAuthCreds, proto, SignalDataTypeMap } from 'baileys';
import { isNotEmpty } from 'class-validator';

export type AuthState = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
};

export class AuthStateProvider {
  constructor(private readonly providerFiles: ProviderFiles) {}

  private readonly logger = new Logger('AuthStateProvider');

  public async authStateProvider(instance: string): Promise<AuthState> {
    const [, error] = await this.providerFiles.create(instance);
    if (error) {
      this.logger.error(['Failed to create folder on file server', error?.message, error?.stack]);
      return;
    }

    const writeData = async (data: any, key: string): Promise<any> => {
      const json = JSON.stringify(data, BufferJSON.replacer);
      const [response, error] = await this.providerFiles.write(instance, key, {
        data: json,
      });
      if (error) {
        // this.logger.error(['writeData', error?.message, error?.stack]);
        return;
      }
      return response;
    };

    const readData = async (key: string): Promise<any> => {
      const [response, error] = await this.providerFiles.read(instance, key);
      if (error) {
        // this.logger.error(['readData', error?.message, error?.stack]);
        return;
      }
      if (isNotEmpty(response?.data)) {
        return JSON.parse(JSON.stringify(response.data), BufferJSON.reviver);
      }
    };

    const removeData = async (key: string) => {
      const [response, error] = await this.providerFiles.delete(instance, key);
      if (error) {
        // this.logger.error(['removeData', error?.message, error?.stack]);
        return;
      }

      return response;
    };

    const removeCreds = async () => {
      const [response, error] = await this.providerFiles.removeSession(instance);
      if (error) {
        // this.logger.error(['removeData', error?.message, error?.stack]);
        return;
      }

      logger.info({ action: 'remove.session', instance, response });

      return;
    };

    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids: string[]) => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const data: { [_: string]: SignalDataTypeMap[type] } = {};
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData(`${type}-${id}`);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.create(value);
                }

                data[id] = value;
              }),
            );

            return data;
          },
          set: async (data: any) => {
            const tasks: Promise<void>[] = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${category}-${id}`;
                tasks.push(value ? await writeData(value, key) : await removeData(key));
              }
            }

            await Promise.all(tasks);
          },
        },
      },
      saveCreds: async () => {
        return await writeData(creds, 'creds');
      },

      removeCreds,
    };
  }
}

const logger = new Logger('useMultiFileAuthStatePrisma');
