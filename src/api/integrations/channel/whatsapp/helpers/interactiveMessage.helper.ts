import { Button, KeyType } from '@api/dto/sendMessage.dto';
import { BinaryNode } from 'baileys';

export function buildInteractiveBizNode(): BinaryNode {
  return {
    tag: 'biz',
    attrs: {},
    content: [
      {
        tag: 'interactive',
        attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
      },
    ],
  };
}

/**
 * Stanza nodes for the PIX button (`payment_info`).
 *
 * The generic `mixed` node above is enough for WhatsApp Web, but Android/iOS
 * only render the payment card when the native_flow is named `payment_info`
 * and, in 1:1 chats, when the stanza also carries `<bot biz_bot="1"/>`.
 * Without them the message is delivered but nothing shows up on the phone.
 */
export function buildPixBizNodes(jid: string): BinaryNode[] {
  const nodes: BinaryNode[] = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{ tag: 'native_flow', attrs: { name: 'payment_info' } }],
        },
      ],
    },
  ];

  if (!/@(g\.us|newsletter|broadcast)$/.test(jid)) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }

  return nodes;
}

/**
 * Biz node específico para `listMessage` legado.
 * Necessário para o WhatsApp Web/Desktop renderizar a lista — o moderno
 * (`interactiveMessage` + `single_select`) não é renderizado no Web.
 */
export function buildListBizNode(): BinaryNode {
  return {
    tag: 'biz',
    attrs: {},
    content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }],
  };
}

type NativeFlowButton = { name: string; buttonParamsJson: string };

type NativeFlowDeps = {
  generateRandomId: () => string;
  mapKeyType: Map<KeyType, string>;
};

export function toNativeFlowButton(button: Button, deps: NativeFlowDeps): NativeFlowButton {
  const displayText = button.displayText ?? '';

  switch (button.type) {
    case 'url':
      return {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: displayText,
          url: button.url,
          merchant_url: button.url,
        }),
      };

    case 'call':
      return {
        name: 'cta_call',
        buttonParamsJson: JSON.stringify({
          display_text: displayText,
          phone_number: button.phoneNumber,
        }),
      };

    case 'copy':
      return {
        name: 'cta_copy',
        buttonParamsJson: JSON.stringify({
          display_text: displayText,
          copy_code: button.copyCode,
        }),
      };

    case 'reply':
      return {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: displayText,
          id: button.id ?? deps.generateRandomId(),
        }),
      };

    case 'pix':
      return {
        name: 'payment_info',
        buttonParamsJson: JSON.stringify({
          currency: button.currency,
          total_amount: { value: 0, offset: 100 },
          reference_id: deps.generateRandomId(),
          type: 'physical-goods',
          order: {
            status: 'pending',
            subtotal: { value: 0, offset: 100 },
            order_type: 'ORDER',
            items: [
              { name: '', amount: { value: 0, offset: 100 }, quantity: 0, sale_amount: { value: 0, offset: 100 } },
            ],
          },
          payment_settings: [
            {
              type: 'pix_static_code',
              pix_static_code: {
                merchant_name: button.name,
                key: button.key,
                key_type: deps.mapKeyType.get(button.keyType),
              },
            },
          ],
          share_payment_status: false,
        }),
      };

    default:
      throw new Error(`Unsupported button type: ${(button as Button).type}`);
  }
}

type ListSection = {
  title: string;
  rows: Array<{ title: string; description?: string; rowId: string }>;
};

export function buildSingleSelectButton(buttonText: string, sections: ListSection[]): NativeFlowButton {
  const buttonParams = {
    title: buttonText || ' ',
    sections: (sections || []).map((section) => ({
      title: section.title || ' ',
      highlight_label: '',
      rows: (section.rows || []).map((row, index) => {
        const rowTitle = row.title || ' ';
        return {
          header: rowTitle,
          title: rowTitle,
          description: row.description || ' ',
          id: row.rowId || `row_${index}`,
        };
      }),
    })),
  };

  return {
    name: 'single_select',
    buttonParamsJson: JSON.stringify(buttonParams),
  };
}
