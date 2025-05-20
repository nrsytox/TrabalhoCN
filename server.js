require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const session = require("express-session");
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const axios = require("axios");
const stream = require("stream");
const util = require("util");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

// Sessões
app.use(
  session({
    secret: "segredo-super-seguro",
    resave: false,
    saveUninitialized: true,
  })
);

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

// Middleware para atualizar orçamento
app.use(async (req, res, next) => {
  if (!req.session.user) return next(); // Alterado para verificar session

  try {
    const userId = req.session.user.id;
    const { resource: user } = await usersContainer.item(userId, userId).read(); // Usar usersContainer

    if (!user) return next();

    const hoje = new Date();
    const ultimoReset = new Date(user.ultimo_reset);
    const primeiroDiaMesAtual = new Date(
      hoje.getFullYear(),
      hoje.getMonth(),
      1
    );

    // Reset se:
    // 1. O último reset foi no mês passado E
    // 2. Já estamos no dia 1 ou depois
    if (ultimoReset < primeiroDiaMesAtual && hoje >= primeiroDiaMesAtual) {
      user.orcamento_restante = user.orcamento_mensal;
      user.ultimo_reset = hoje.toISOString();
      await usersContainer.item(userId, userId).replace(user);

      // Atualiza a sessão
      req.session.user.orcamento_restante = user.orcamento_restante;
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Erro no middleware de reset:", err);
    next();
  }
});

// ======================= ROTAS ========================== //

// Rotas estáticas
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/dashboard", authMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);
app.get("/perfil", authMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "perfil.html"))
);

// API para obter dados do perfil
app.get("/api/perfil", authMiddleware, (req, res) => {
  res.json(req.session.user);
});

// Registar
app.post("/auth/register", async (req, res) => {
  const { nome, email, password, orcamento_mensal } = req.body;

  const { resources: existingUsers } = await usersContainer.items
    .query({
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    })
    .fetchAll();

  if (existingUsers.length > 0)
    return res.status(400).json({ message: "Email já registado" });

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    id: uuidv4(),
    nome,
    email,
    password: hashedPassword,
    orcamento_mensal: Number(orcamento_mensal),
    orcamento_restante: Number(orcamento_mensal),
    grupos: [],
    notificacoes: [],
    ultimo_reset: new Date().toISOString(),
  };

  await usersContainer.items.create(newUser);

  req.session.user = {
    id: newUser.id,
    nome: newUser.nome,
    email: newUser.email,
    orcamento_mensal: newUser.orcamento_mensal,
    orcamento_restante: newUser.orcamento_restante,
  };

  res.redirect("/dashboard");
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const { resources } = await usersContainer.items
    .query({
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    })
    .fetchAll();

  if (resources.length === 0)
    return res.status(401).json({ message: "Email não encontrado" });

  const user = resources[0];
  if (!(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ message: "Password incorreta" });

  req.session.user = {
    id: user.id,
    nome: user.nome,
    email: user.email,
    orcamento_mensal: user.orcamento_mensal,
    orcamento_restante: user.orcamento_restante,
  };

  res.redirect("/dashboard");
});

// API para categorias
app.get("/api/categorias", async (req, res) => {
  const { resources } = await categoriasContainer.items
    .query("SELECT * FROM c")
    .fetchAll();
  res.json(resources);
});

// API para grupos
app.post("/api/grupos", authMiddleware, async (req, res) => {
  try {
    const { nome, membros } = req.body;

    if (!nome || !Array.isArray(membros) || membros.length === 0) {
      return res
        .status(400)
        .json({ error: "Nome do grupo e membros são obrigatórios." });
    }

    const newGroup = {
      id: uuidv4(),
      nome,
      membros,
      criadorId: req.session.user.id,
      dataCriacao: new Date().toISOString(),
    };

    await gruposContainer.items.create(newGroup);

    // Adicionar o grupo ao array 'grupos' de cada utilizador
    await Promise.all(
      membros.map(async (userId) => {
        const { resource: user } = await usersContainer
          .item(userId, userId)
          .read();
        if (user) {
          user.grupos = user.grupos || [];
          if (!user.grupos.includes(newGroup.id)) {
            user.grupos.push(newGroup.id);
            await usersContainer.item(userId, userId).replace(user);
          }
        }
      })
    );

    res.status(201).json({ success: true, group: newGroup });
  } catch (error) {
    console.error("Erro ao criar grupo:", error);
    res.status(500).json({ error: "Erro ao criar grupo." });
  }
});

app.post("/api/despesas", authMiddleware, async (req, res) => {
  try {
    const { descricao, valor, categoria, grupo } = req.body;
    const userId = req.session.user.id;

    // 1. Verificar se é despesa de grupo
    let participantesIds = [userId];
    let valorPorParticipante = Number(valor);
    let numMembros = 1;

    if (grupo) {
      const { resource: grupoDoc } = await gruposContainer
        .item(grupo, grupo)
        .read();
      if (!grupoDoc) throw new Error("Grupo não encontrado");
      participantesIds = grupoDoc.membros;
      numMembros = participantesIds.length;
      valorPorParticipante = Number(valor) / numMembros;
    }

    // 2. Chamar HTTP Trigger para verificação
    const { data: verificacao } = await axios.post(
      process.env.HTTP_TRIGGER_URL,
      {
        valorTotal: Number(valor),
        orcamentoMensal: req.session.user.orcamento_mensal,
        orcamentoRestante: req.session.user.orcamento_restante,
        numMembros: numMembros,
      }
    );

    app.get("/api/users", authMiddleware, async (req, res) => {
      const q = req.query.q || "";
      if (!q) return res.json([]);
      const { resources } = await usersContainer.items
        .query({
          query: "SELECT c.id, c.nome, c.email FROM c WHERE c.id = @q",
          parameters: [{ name: "@q", value: q }],
        })
        .fetchAll();
      res.json(resources);
    });

    // 3. Atualizar usuários e registrar transação
    await Promise.all(
      participantesIds.map(async (participanteId) => {
        const { resource: user } = await usersContainer
          .item(participanteId, participanteId)
          .read();
        user.orcamento_restante -= valorPorParticipante;

        // Verificar se é o usuário atual e se há alerta
        if (participanteId === userId && verificacao.alerta) {
          user.notificacoes = [
            ...(user.notificacoes || []),
            {
              id: Date.now().toString(),
              tipo: verificacao.alerta.tipo,
              mensagem: verificacao.alerta.mensagem,
              data: new Date().toISOString(),
              lida: false,
            },
          ];
        }

        await usersContainer.item(participanteId, participanteId).replace(user);
      })
    );

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
      data: new Date().toISOString(),
    });

    // 5. Atualizar sessão
    const { resource: updatedUser } = await usersContainer
      .item(userId, userId)
      .read();
    req.session.user.orcamento_restante = updatedUser.orcamento_restante;

    res.json({
      success: true,
      alerta: verificacao.alerta,
      orcamento_restante: updatedUser.orcamento_restante,
    });
  } catch (error) {
    console.error("Erro ao adicionar despesa:", error);
    res.status(500).json({ error: error.message });
  }
});

// API para notificações
app.get("/api/notificacoes", authMiddleware, async (req, res) => {
  try {
    const { resource: user } = await usersContainer
      .item(req.session.user.id, req.session.user.id)
      .read();
    res.json({ notificacoes: user.notificacoes || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para marcar notificação como lida
app.put("/api/notificacoes/:id", authMiddleware, async (req, res) => {
  try {
    const { resource: user } = await usersContainer
      .item(req.session.user.id, req.session.user.id)
      .read();
    user.notificacoes = (user.notificacoes || []).map((not) =>
      not.id === req.params.id ? { ...not, lida: true } : not
    );
    await usersContainer
      .item(req.session.user.id, req.session.user.id)
      .replace(user);
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
      query:
        "SELECT TOP @limit * FROM c WHERE ARRAY_CONTAINS(c.participantes, @userId) ORDER BY c.data DESC",
      parameters: [
        { name: "@limit", value: parseInt(limit) },
        { name: "@userId", value: userId },
      ],
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

// Rota para fazer download/exportação
app.get("/exportar", authMiddleware, async (req, res) => {
  try {
    // Base da URL do Docker + possível user_id
    const baseUrl = process.env.DOCKER; // ex: "http://localhost:5000/export?"
    const userId = req.session.user.id; // id do utilizador autenticado
    const exportUrl = `${baseUrl}user_id=${userId}`;

    // Pedido GET ao serviço Docker, em streaming
    const response = await axios.get(exportUrl, {
      responseType: "stream",
    });

    // Propaga os headers de download (nome do ficheiro, tipo)
    res.setHeader(
      "Content-Disposition",
      response.headers["content-disposition"]
    );
    res.setHeader("Content-Type", response.headers["content-type"]);

    // Transfere o stream diretamente para o cliente
    await util.promisify(stream.pipeline)(response.data, res);
  } catch (err) {
    console.error("Erro ao exportar:", err);
    res.status(500).send("Falha na exportação.");
  }
});

const { BlobServiceClient } = require("@azure/storage-blob");
const multer = require("multer");
const upload = multer(); // para lidar com multipart/form-data

const AZURE_SAS_URL = process.env.AZURE_BLOB_SAS_URL;
const blobServiceClient = new BlobServiceClient(AZURE_SAS_URL);
const containerClient = blobServiceClient.getContainerClient(""); // "" pois já vem no SAS URL

// Listar imagens do utilizador
app.get("/api/faturas", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const iterator = containerClient.listBlobsFlat({ prefix: `${userId}/` });

    const files = [];
    for await (const blob of iterator) {
      const blobUrl = `${AZURE_SAS_URL.split("?")[0]}/${blob.name}?${
        AZURE_SAS_URL.split("?")[1]
      }`;
      files.push({ name: blob.name, url: blobUrl });
    }

    res.json({ files });
  } catch (err) {
    console.error("Erro ao listar faturas:", err);
    res.status(500).send("Erro ao listar faturas");
  }
});

// Upload de fatura
app.post(
  "/api/faturas",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = req.session.user.id;
      const file = req.file;
      const blobName = `${userId}/${Date.now()}_${file.originalname}`;

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(file.buffer);

      res.status(201).json({ success: true, blobName });
    } catch (err) {
      console.error("Erro ao fazer upload da fatura:", err);
      res.status(500).send("Erro ao fazer upload da fatura");
    }
  }
);

// Apagar fatura
app.delete("/api/faturas/:blobName", authMiddleware, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const blobName = req.params.blobName;

    // Impede que se apague blobs fora da pasta do utilizador
    if (!blobName.startsWith(`${userId}/`)) {
      return res.status(403).send("Acesso negado");
    }

    const blobClient = containerClient.getBlobClient(blobName);
    await blobClient.deleteIfExists();

    res.json({ success: true });
  } catch (err) {
    console.error("Erro ao apagar fatura:", err);
    res.status(500).send("Erro ao apagar fatura");
  }
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
