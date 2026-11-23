import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data.object !== 'whatsapp_business_account') {
      return {
        status: 'success',
      };
    }

    const entries = data.entry ?? [];

    for (const entry of entries) {
      const changes = entry.changes ?? [];

      for (const change of changes) {
        if (change?.field === 'message_template_status_update') {
          const templateId = change?.value?.message_template_id;

          if (!templateId) {
            this.logger.error('WebhookService -> receiveWebhookMeta -> templateId not found');
            continue;
          }

          const template = await this.prismaRepository.template.findFirst({
            where: {
              templateId: String(templateId),
            },
          });

          if (!template) {
            this.logger.error(`WebhookService -> receiveWebhookMeta -> template not found: ${templateId}`);
            continue;
          }

          if (!template.webhookUrl) {
            this.logger.error(`WebhookService -> receiveWebhookMeta -> template webhookUrl not found: ${templateId}`);
            continue;
          }

          try {
            await axios.post(template.webhookUrl, change.value, {
              headers: {
                'Content-Type': 'application/json',
              },
            });
          } catch (error) {
            this.logger.error(
              `WebhookService -> receiveWebhookMeta -> error sending template webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          continue;
        }

        const numberId = change?.value?.metadata?.phone_number_id;

        if (!numberId) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> numberId not found');
          continue;
        }

        const instances = await this.prismaRepository.instance.findMany({
          where: {
            number: String(numberId),
          },
        });

        if (!instances.length) {
          this.logger.error(`WebhookService -> receiveWebhookMeta -> instances not found for numberId: ${numberId}`);
          continue;
        }

        const webhookData = {
          ...data,
          entry: [
            {
              ...entry,
              changes: [change],
            },
          ],
        };

        const results = await Promise.allSettled(
          instances.map(async (instance) => {
            const waInstance = this.waMonitor.waInstances[instance.name];

            if (!waInstance) {
              throw new Error(`Instance not loaded: ${instance.name}`);
            }

            await waInstance.connectToWhatsapp(webhookData);

            return instance.name;
          }),
        );

        results.forEach((result, index) => {
          const instanceName = instances[index].name;

          if (result.status === 'rejected') {
            this.logger.error(
              `WebhookService -> receiveWebhookMeta -> error processing webhook for instance ${instanceName}: ${
                result.reason instanceof Error ? result.reason.message : String(result.reason)
              }`,
            );
            return;
          }

          this.logger.log(
            `WebhookService -> receiveWebhookMeta -> webhook processed successfully for instance ${instanceName}`,
          );
        });
      }
    }

    return {
      status: 'success',
    };
  }
}
