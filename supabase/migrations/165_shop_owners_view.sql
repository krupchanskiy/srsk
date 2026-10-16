-- Продавцу нужен список владельцев товара, но общий справочник контрагентов
-- финмодуля ему закрыт — там все поставщики ашрама. Представление отдаёт
-- только тех контрагентов, что заведены владельцами в магазине, и только
-- тому, у кого есть доступ к модулю.
create or replace view shop_v_owners as
select o.id, o.contractor_id, c.name, o.loss_policy, o.note, o.is_active,
       coalesce(d.debt, 0) as debt
from shop_owners o
join fin_contractors c on c.id = o.contractor_id
left join shop_v_owner_debt d on d.owner_id = o.id
where shop_can_view();

revoke all on shop_v_owners from public, anon;
grant select on shop_v_owners to authenticated, service_role;
