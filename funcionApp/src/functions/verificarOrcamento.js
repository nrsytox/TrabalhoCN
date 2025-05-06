const { CosmosClient } = require("@azure/cosmos");

const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = "gestao_despesas";
const containerId = "user";

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

module.exports = async function (context, req) {
  const { userId, valor } = req.body;

  if (!userId || !valor) {
    context.res = { status: 400, body: "Faltam parâmetros." };
    return;
  }

  try {
    const { resource: user } = await container.item(userId, userId).read();

    if (!user) {
      context.res = { status: 404, body: "Utilizador não encontrado." };
      return;
    }

    user.orcamento_restante -= valor;

    let alerta = null;
    const percentagemGasta = ((user.orcamento_mensal - user.orcamento_restante) / user.orcamento_mensal) * 100;

    if (percentagemGasta >= 80 && percentagemGasta < 100) {
      alerta = "Já gastou mais de 80% do seu orçamento";
    } else if (user.orcamento_restante <= 0) {
      alerta = "Já ultrapassou o seu orçamento mensal";
    }

    await container.item(userId, userId).replace(user);

    context.res = {
      status: 200,
      body: { alerta, orcamento_restante: user.orcamento_restante }
    };

  } catch (err) {
    context.log(err);
    context.res = { status: 500, body: "Erro interno: " + err.message };
  }
};
