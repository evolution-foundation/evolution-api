import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');
  protected readonly channelIntegration: string = Integration.WHATSAPP_BUSINESS;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data?.object !== 'whatsapp_business_account') return { status: 'success' };

    for (const entry of data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'message_template_status_update') {
          const template = await this.prismaRepository.template.findFirst({
            where: { templateId: `${change.value?.message_template_id}` },
          });

          if (!template) {
            console.log('template not found');
            continue;
          }

          const { webhookUrl } = template;

          await axios.post(webhookUrl, change.value, {
            headers: {
              'Content-Type': 'application/json',
            },
          });
          continue;
        }

        const numberId = change.value?.metadata?.phone_number_id;

        if (!numberId) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> numberId not found');
          continue;
        }

        const instance = await this.prismaRepository.instance.findFirst({
          where: { number: numberId, integration: this.channelIntegration },
        });

        if (!instance) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> instance not found');
          continue;
        }

        const channel = this.waMonitor.waInstances[instance.name];
        if (!channel) throw new Error('Instância da Cloud API indisponível para processar o webhook');

        await channel.connectToWhatsapp({ ...data, entry: [{ ...entry, changes: [change] }] });
      }
    }

    return {
      status: 'success',
    };
  }
}
