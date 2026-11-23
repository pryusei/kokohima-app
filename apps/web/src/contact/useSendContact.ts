import type { ContactMessageRequest } from "@kokohima/shared";
import { useMutation } from "@tanstack/react-query";
import { apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";

// 問い合わせを送る（docs/specs/T-24-contact.md「9.」）。応答に本文がないので、無効にするクエリはない。楽観的更新はしない
// 冪等キー：通信できない・5xx のあとに同じ内容で送り直すと同じキー。4xx・内容の変更・成功のあとは新しいキー（T-10）

const PATH = "/api/v1/contact-messages";

export function useSendContact() {
  const idempotency = useIdempotencyKey();
  return useMutation({
    mutationFn: (input: ContactMessageRequest) =>
      apiSend("POST", PATH, input, undefined, { idempotencyKey: idempotency.keyFor(signatureOf(PATH, input)) }),
    onSettled: (_data, error) => idempotency.settle(error),
  });
}
