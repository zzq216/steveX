package name.modid.arena;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * 游戏内 {@code /arena <场地>}：把执行者传送到场地外的平台（方案 T1）。
 *
 * <p>不要求作弊权限，agent 也能用，所以只开放这一个无害操作；训练进行中拒绝执行，
 * 免得 agent 中途把自己传出场地。开始训练统一走 DSH 的 {@code /bt train}。
 */
public final class ArenaCommand {

    private ArenaCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("arena")
                .then(Commands.argument("name", StringArgumentType.word())
                        .suggests((ctx, builder) -> SharedSuggestionProvider.suggest(ArenaManager.known().keySet(), builder))
                        .executes(ctx -> {
                            CommandSourceStack source = ctx.getSource();
                            ServerPlayer player = source.getPlayerOrException();
                            String name = StringArgumentType.getString(ctx, "name");
                            if (ArenaManager.isActive()) {
                                source.sendFailure(Component.literal("训练进行中，结束前不能用 /arena"));
                                return 0;
                            }
                            BlockPos origin = ArenaManager.known().get(name);
                            if (origin == null) {
                                source.sendFailure(Component.literal("未知场地 " + name + "（已有："
                                        + String.join(", ", ArenaManager.known().keySet()) + "）"));
                                return 0;
                            }
                            ArenaManager.build(source.getServer(), name, origin);
                            ArenaManager.teleportOutside(source.getServer(), player, origin);
                            source.sendSuccess(() -> Component.literal("训练场 " + name + "：在 DSH 输入 /bt train " + name + " 开始训练"), false);
                            return 1;
                        })));
    }
}
