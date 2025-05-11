require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const session = require("express-session");
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const axios = require('axios');
const cron = require("node-cron");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

// Sessões
app.use(session({
  secret: "segredo-super-seguro",
  resave: false,
  saveUninitialized: true
}));

// Cosmos DB config
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = "gestao_despesas";
const client = new CosmosClient({ endpoint, key });

// Containers
const usersContainer = client.database(databaseId).container("user");
const gruposContainer = client.database(databaseId).container("grupos");
const transacoesContainer = client.database(databaseId).container("transacoes");
const categoriasContainer = client.database(databaseId).container("categorias");

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (req.session.user) next();
  else res.status(401).json({ error: "Não autenticado" });
}

// ======================= ROTAS ========================== //

// Rotas estáticas
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/perfil", authMiddleware, (req, res) => res.sendFile(path.join(__dirname, "public", "perfil.html")));

// API para obter dados do perfil
app.get("/api/perfil", authMiddleware, (req, res) => {
  res.json(req.session.user);
});

// Registar
app.post("/auth/register", async (req, res) => {
    const { nome, email, password, orcamento_mensal } = req.body;

    const { resources: existingUsers } = await usersContainer.items
      .query({ query: "SELECT * FROM c WHERE c.email = @email", parameters: [{ name: "@email", value: email }] })
      .fetchAll();

    if (existingUsers.length > 0) return res.status(400).json({ message: "Email já registado" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
      id: uuidv4(),
      nome,
      email,
      password: hashedPassword,
      orcamento_mensal: Number(orcamento_mensal),
      orcamento_restante: Number(orcamento_mensal),
      grupos: [],
      notificacoes: []
    };

    await usersContainer.items.create(newUser);
    
    req.session.user = {
      id: newUser.id,
      nome: newUser.nome,
      email: newUser.email,
      orcamento_mensal: newUser.orcamento_mensal,
      orcamento_restante: newUser.orcamento_restante
    };
    
    res.redirect("/dashboard");
});

// Login
app.post("/auth/login", async (req, res) => {
    const { email, password } = req.body;

    const { resources } = await usersContainer.items
      .query({ query: "SELECT * FROM c WHERE c.email = @email", parameters: [{ name: "@email", value: email }] })
      .fetchAll();

    if (resources.length === 0) return res.status(401).json({ message: "Email não encontrado" });

    const user = resources[0];
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ message: "Password incorreta" });

    req.session.user = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      orcamento_mensal: user.orcamento_mensal,
      orcamento_restante: user.orcamento_restante
    };

    res.redirect("/dashboard");
});

// API para categorias
app.get("/api/categorias", async (req, res) => {
    const { resources } = await categoriasContainer.items.query("SELECT * FROM c").fetchAll();
    res.json(resources);
});

// API para grupos
app.get("/api/grupos", authMiddleware, async (req, res) => {
    const { resources } = await gruposContainer.items
      .query({ query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.membros, @id)", parameters: [{ name: "@id", value: req.session.user.id }] })
      .fetchAll();
    res.json(resources);
});

// API para adicionar despesa (atualizada)
app.post("/api/despesas", authMiddleware, async (req, res) => {
  try {
    const { descricao, valor, categoria, grupo } = req.body;
    const userId = req.session.user.id;

    // 1. Verificar se é despesa de grupo
    let participantesIds = [userId];
    let valorPorParticipante = Number(valor);

    if (grupo) {
      const { resource: grupoDoc } = await gruposContainer.item(grupo, grupo).read();
      if (!grupoDoc) throw new Error("Grupo não encontrado");
      participantesIds = grupoDoc.membros;
      valorPorParticipante = Number(valor) / participantesIds.length;
    }

    // 2. Chamar HTTP Trigger para verificação
    const { data: verificacao } = await axios.post(process.env.HTTP_TRIGGER_URL, {
      valorGasto: valorPorParticipante,
      orcamentoMensal: req.session.user.orcamento_mensal,
      orcamentoRestante: req.session.user.orcamento_restante
    });

    // 3. Atualizar usuários e registrar transação
    await Promise.all(participantesIds.map(async participanteId => {
      const { resource: user } = await usersContainer.item(participanteId, participanteId).read();
      user.orcamento_restante -= valorPorParticipante;
      
      if (verificacao.alerta) {
        user.notificacoes = [...(user.notificacoes || []), {
          id: Date.now().toString(),
          mensagem: verificacao.alerta,
          data: new Date().toISOString(),
          lida: false
        }];
      }

      await usersContainer.item(participanteId, participanteId).replace(user);
    }));

    // 4. Registrar transação
    await transacoesContainer.items.create({
      id: uuidv4(),
      descricao,
      valor: Number(valor),
      valorIndividual: valorPorParticipante,
      categoriaId: categoria,
      pagadorId: userId,
      grupoId: grupo || null,
      participantes: participantesIds,
      data: new Date().toISOString()
    });

    // 5. Atualizar sessão
    const { resource: updatedUser } = await usersContainer.item(userId, userId).read();
    req.session.user.orcamento_restante = updatedUser.orcamento_restante;

    res.json({
      success: true,
      alerta: verificacao.alerta,
      orcamento_restante: updatedUser.orcamento_restante
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para notificações
app.get("/api/notificacoes", authMiddleware, async (req, res) => {
  try {
    const { resource: user } = await usersContainer.item(req.session.user.id, req.session.user.id).read();
    res.json({ notificacoes: user.notificacoes || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para marcar notificação como lida
app.put("/api/notificacoes/:id", authMiddleware, async (req, res) => {
  try {
    const { resource: user } = await usersContainer.item(req.session.user.id, req.session.user.id).read();
    user.notificacoes = (user.notificacoes || []).map(not => 
      not.id === req.params.id ? { ...not, lida: true } : not
    );
    await usersContainer.item(req.session.user.id, req.session.user.id).replace(user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//Endpoint para obter transações
app.get("/api/transacoes", authMiddleware, async (req, res) => {
    const { userId, limit = 5 } = req.query;
    const { resources } = await transacoesContainer.items
        .query({
            query: "SELECT TOP @limit * FROM c WHERE ARRAY_CONTAINS(c.participantes, @userId) ORDER BY c.data DESC",
            parameters: [
                { name: "@limit", value: parseInt(limit) },
                { name: "@userId", value: userId }
            ]
        })
        .fetchAll();
    res.json(resources);
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Erro ao terminar sessão:", err);
    res.json({ success: true });
  });
});

// ======================= CRON JOB ======================= //

// Resetar orçamento de cada utilizador no dia 1 de cada mês
cron.schedule("0 0 0 1 * *", async () => {
  console.log("⏰ Cron Job: Atualizar orçamentos mensais");

  try {
    const { resources: users } = await container.items.query("SELECT * FROM c").fetchAll();

    for (const user of users) {
      user.orcamento_restante = user.orcamento_mensal;
      await container.item(user.id, user.id).replace(user);
    }

    console.log("✅ Orçamentos mensais atualizados");
  } catch (error) {
    console.error("Erro no cron job de atualização de orçamentos:", error.message);
  }
});

// Servidor
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Servidor a correr em http://localhost:${PORT}`);
});