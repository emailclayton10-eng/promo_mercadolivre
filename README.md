# Promo ML

Aplicação conectada à API do Mercado Livre para **incluir anúncios em campanhas promocionais em massa**, respeitando o **custo** e o **lucro mínimo** de cada produto.

- **Produtos** são cadastrados por você (manualmente ou via CSV): SKU, custo e, opcionalmente, margem/lucro mínimos próprios.
- **Anúncios** e **campanhas** são importados do Mercado Livre.
- Cada anúncio é **vinculado** a um ou mais produtos (anúncio simples, kit `2x`, ou combo de produtos diferentes). Um mesmo produto pode ter centenas ou milhares de anúncios.
- Para cada campanha, a aplicação calcula preço promocional, lucro e margem de cada anúncio candidato e mostra o que é **viável**. Com um clique você inclui todos os viáveis — em uma campanha ou em várias ao mesmo tempo.

## Como rodar

Requisito: **Node.js 22.13+** (usa o SQLite nativo do Node, sem dependências nativas para compilar).

```bash
npm install
cp .env.example .env     # preencha as credenciais do Mercado Livre
npm start                # http://localhost:3000
```

### Rodar direto no navegador (GitHub Codespaces)

No GitHub: **Code → Codespaces → Create codespace on main**. As dependências são instaladas e a aplicação (modo demonstração) inicia sozinha, abrindo uma aba na porta 3000. Para voltar depois, acesse <https://github.com/codespaces> e abra o codespace existente: a aplicação inicia de novo automaticamente.

### Modo demonstração (sem conta do Mercado Livre)

```bash
npm run demo
```

Usa uma API do Mercado Livre simulada com 400 anúncios e 6 campanhas fictícias. No Painel: **Conectar** → **Gerar produtos de exemplo** → **Importar anúncios** → **Importar campanhas**; depois, em Anúncios, **Vincular automaticamente por SKU**.

### Testes

```bash
npm test
```

Inclui testes do cálculo de preço e um teste de ponta a ponta contra a API simulada (importar → vincular → avaliar → incluir → remover).

## Configurando o acesso ao Mercado Livre

1. Crie um aplicativo em <https://developers.mercadolivre.com.br/devcenter>.
2. Em **Redirect URI**, cadastre a URL `https://SEU-DOMINIO/auth/callback` (o Mercado Livre exige HTTPS; para uso local, use um túnel como ngrok ou cloudflared).
3. Habilite os escopos de leitura/escrita e **offline access** (para renovar o token automaticamente) e a permissão de **promoções**.
4. Preencha `ML_CLIENT_ID`, `ML_CLIENT_SECRET` e `ML_REDIRECT_URI` no `.env` e clique em **Conectar ao Mercado Livre** no Painel.

Se não quiser expor a aplicação, conecte pelo painel usando **"Colar código de autorização manualmente"**: após autorizar, copie o parâmetro `code` da URL de retorno e cole no campo.

Para proteger a aplicação com senha, defina `APP_USER` e `APP_PASSWORD`.

## Fluxo de trabalho

1. **Painel → Regras de lucro**: margem mínima padrão, lucro mínimo padrão, impostos, custo fixo por faixa de preço e limite do frete grátis.
2. **Produtos**: cadastre ou importe CSV (`sku;nome;custo;margem_minima;lucro_minimo`).
3. **Painel → Importar anúncios**: traz todos os anúncios (ativos/pausados), a comissão de cada categoria/tipo e o custo do frete grátis de cada anúncio.
4. **Anúncios → Vincular**:
   - **Automático por SKU**: `ABC` → produto ABC; `ABC-KIT3`, `ABC_X3`, `ABC*3` → 3× ABC; `ABC+DEF` → combo.
   - **Em massa**: busque (ex.: "camiseta preta"), clique em *Selecionar todos os N do filtro*, escolha o produto e a quantidade, **Vincular**.
   - **CSV**: `anuncio;sku;quantidade` (repita o anúncio em várias linhas para montar um kit).
5. **Campanhas → Importar campanhas**, abra uma campanha e escolha como definir o preço:
   - **Percentual geral**: o mesmo desconto para todos (ajustado à faixa permitida pela campanha).
   - **Maior desconto viável**: para cada anúncio, o menor preço que ainda respeita lucro e margem mínimos.
   - **Preço sugerido pela campanha**.
   
   Os filtros *Viáveis / Inviáveis / Sem vínculo / Participando* recalculam na hora. **Incluir todos os viáveis** envia tudo em segundo plano (com várias requisições em paralelo e novas tentativas automáticas em caso de limite de requisições) e mostra o progresso.
6. Na lista de campanhas, selecione várias e use **Incluir todos os viáveis** para aplicar o mesmo critério em todas de uma vez.

## Como a viabilidade é calculada

```
lucro  = preço recebido − comissão − custo fixo − frete pago pelo vendedor − impostos − custo dos produtos
margem = lucro ÷ preço recebido
viável = lucro ≥ lucro mínimo  E  margem ≥ margem mínima
```

- **Comissão**: percentual da categoria + tipo de anúncio (via `/sites/MLB/listing_prices`), ou ajuste manual por anúncio.
- **Custo fixo**: por faixa de preço (configurável no Painel — confira os valores vigentes).
- **Frete**: custo do frete grátis do anúncio (`/users/{id}/shipping_options/free`); abaixo do limite de frete grátis (R$ 79 por padrão) considera que o vendedor não paga. Pode ser fixado manualmente por anúncio.
- **Custo dos produtos**: soma de `custo × quantidade` dos produtos vinculados.
- **Lucro/margem mínimos**: do produto (lucro mínimo é por unidade e multiplica pela quantidade no kit) ou, se não definidos, o padrão do Painel.
- **Campanhas co-participadas** (ML cobre parte do desconto): o lucro usa o valor que você efetivamente recebe (`preço original × (1 − % do vendedor)`).
- O **preço mínimo viável** é calculado de forma exata (a função de lucro é linear por partes entre as faixas de custo fixo e o limite do frete grátis), e o **desconto máximo** exibido é derivado dele.

## Tipos de campanha suportados

| Tipo | Preço | Campos enviados |
|---|---|---|
| `DEAL` (tradicional), `SELLER_CAMPAIGN`, `DOD` (oferta do dia) | você define (dentro da faixa) | `deal_price` |
| `LIGHTNING` (relâmpago) | você define | `deal_price`, `stock` |
| `MARKETPLACE_CAMPAIGN` (co-participada) | definido pela campanha | — |
| `SMART`, `PRICE_MATCHING`, `UNHEALTHY_STOCK`, `PRE_NEGOTIATED` | definido pela campanha | `offer_id` |

Endpoints usados: `GET /seller-promotions/users/{user_id}`, `GET /seller-promotions/promotions/{id}/items`, `POST /seller-promotions/items/{item_id}`, `DELETE /seller-promotions/items/{item_id}` (todos com `app_version=v2`).

## Estrutura

```
src/
  server.js              rotas HTTP (Express)
  db.js                  esquema SQLite e configurações
  ml/client.js           cliente da API do ML (OAuth, renovação de token, retry/backoff)
  ml/mock.js             API do ML simulada (demo e testes)
  services/pricing.js    lucro, margem e preço mínimo viável
  services/promotions.js avaliação das campanhas e inclusão/remoção em massa
  services/catalog.js    produtos, anúncios, vínculos e CSV
  services/sync.js       importação de anúncios, tarifas, frete e campanhas
  services/jobs.js       tarefas em segundo plano com progresso
public/                  interface web (HTML/CSS/JS, sem etapa de build)
test/                    testes (node:test)
```

Variáveis de ambiente: veja `.env.example`. `ML_CONCURRENCY` controla quantas requisições simultâneas são feitas à API (padrão 5).
